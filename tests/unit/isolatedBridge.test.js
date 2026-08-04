'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { IsolatedBridge, injectAgent } = require('../../app/browser/bridge/isolatedBridge');
const { buildAgentSource } = require('../../app/browser/bridge/mainWorldAgent');
const { MARKER, PROTOCOL_VERSION } = require('../../app/browser/bridge/protocol');

const ORIGIN = 'https://teams.microsoft.com';
const SESSION = 'sess-1';

/**
 * Fake window that records posted messages and can deliver messages back,
 * standing in for the shared page/preload window.
 */
function createFakeWindow(origin = ORIGIN) {
	const listeners = [];
	const posted = [];
	const win = {
		posted,
		location: { origin },
		addEventListener: (type, fn) => {
			if (type === 'message') listeners.push(fn);
		},
		removeEventListener: (type, fn) => {
			const i = listeners.indexOf(fn);
			if (i >= 0) listeners.splice(i, 1);
		},
		postMessage: (data, targetOrigin) => posted.push({ data, targetOrigin }),
		listenerCount: () => listeners.length,
	};
	// Deliver a message as if it came from this same window.
	win.deliver = (data, { source = win, origin: eventOrigin = origin } = {}) => {
		for (const fn of [...listeners]) fn({ data, source, origin: eventOrigin });
	};
	return win;
}

function makeBridge(overrides = {}) {
	const window = overrides.window ?? createFakeWindow();
	const bridge = new IsolatedBridge({
		window,
		sessionId: SESSION,
		acceptedChannels: ['camera-settings', 'speaking-state'],
		...overrides,
	});
	return { bridge, window };
}

/** Builds the response the agent would send for a given request. */
function responseFor(request, payload) {
	return {
		[MARKER]: SESSION,
		v: PROTOCOL_VERSION,
		kind: 'response',
		id: request.id,
		channel: request.channel,
		payload,
	};
}

describe('IsolatedBridge - lifecycle', () => {
	it('only attaches one listener regardless of repeated starts', () => {
		const { bridge, window } = makeBridge();
		bridge.start();
		bridge.start();
		assert.strictEqual(window.listenerCount(), 1);
		bridge.stop();
		assert.strictEqual(window.listenerCount(), 0);
	});

	it('rejects requests before start', async () => {
		const { bridge } = makeBridge();
		await assert.rejects(() => bridge.request('camera-settings', {}), /not started/);
	});

	it('rejects in-flight requests when stopped', async () => {
		const { bridge } = makeBridge();
		bridge.start();
		const pending = bridge.request('camera-settings', {});
		bridge.stop();
		await assert.rejects(() => pending, /stopped/);
	});

	it('requires a window and a session id', () => {
		assert.throws(() => new IsolatedBridge({ sessionId: SESSION }), /window/);
		assert.throws(() => new IsolatedBridge({ window: createFakeWindow(), sessionId: '' }), /sessionId/);
	});
});

describe('IsolatedBridge - request and response', () => {
	it('posts a request to the page origin and resolves on the matching response', async () => {
		const { bridge, window } = makeBridge();
		bridge.start();

		const promise = bridge.request('camera-settings', { deviceId: 'cam0' });
		assert.strictEqual(window.posted.length, 1);
		const { data: request, targetOrigin } = window.posted[0];

		assert.strictEqual(targetOrigin, ORIGIN);
		assert.strictEqual(request.kind, 'request');
		assert.strictEqual(request.channel, 'camera-settings');
		assert.deepStrictEqual(request.payload, { deviceId: 'cam0' });

		window.deliver(responseFor(request, { width: 1280 }));
		assert.deepStrictEqual(await promise, { width: 1280 });
	});

	it('issues distinct ids so concurrent requests do not cross', async () => {
		const { bridge, window } = makeBridge();
		bridge.start();

		const first = bridge.request('camera-settings', { n: 1 });
		const second = bridge.request('camera-settings', { n: 2 });
		const [reqA, reqB] = window.posted.map((p) => p.data);
		assert.notStrictEqual(reqA.id, reqB.id);

		window.deliver(responseFor(reqB, 'second'));
		window.deliver(responseFor(reqA, 'first'));

		assert.strictEqual(await first, 'first');
		assert.strictEqual(await second, 'second');
	});

	it('rejects when the agent reports an error', async () => {
		const { bridge, window } = makeBridge();
		bridge.start();
		const promise = bridge.request('camera-settings', {});
		window.deliver(responseFor(window.posted[0].data, { error: 'no camera' }));
		await assert.rejects(() => promise, /no camera/);
	});

	it('times out rather than hanging forever', async () => {
		const { bridge } = makeBridge();
		bridge.start();
		await assert.rejects(() => bridge.request('camera-settings', {}, { timeoutMs: 10 }), /timed out/);
	});

	it('ignores a response whose channel does not match the request', async () => {
		const { bridge, window } = makeBridge();
		bridge.start();
		const promise = bridge.request('camera-settings', {}, { timeoutMs: 40 });

		const request = window.posted[0].data;
		// Same id, different channel - must not resolve the camera request.
		window.deliver({ ...responseFor(request, 'wrong'), channel: 'speaking-state' });

		await assert.rejects(() => promise, /timed out/);
	});
});

describe('IsolatedBridge - hostile inbound traffic', () => {
	it('ignores messages from another window', async () => {
		const { bridge, window } = makeBridge();
		bridge.start();
		const promise = bridge.request('camera-settings', {}, { timeoutMs: 40 });

		const request = window.posted[0].data;
		window.deliver(responseFor(request, 'spoofed'), { source: { other: true } });

		await assert.rejects(() => promise, /timed out/);
	});

	it('ignores messages claiming a different origin', async () => {
		const { bridge, window } = makeBridge();
		bridge.start();
		const promise = bridge.request('camera-settings', {}, { timeoutMs: 40 });

		const request = window.posted[0].data;
		window.deliver(responseFor(request, 'spoofed'), { origin: 'https://evil.test' });

		await assert.rejects(() => promise, /timed out/);
	});

	it('ignores an unsolicited response for a channel it never requested', () => {
		const { bridge, window } = makeBridge();
		bridge.start();
		assert.doesNotThrow(() =>
			window.deliver({
				[MARKER]: SESSION,
				v: PROTOCOL_VERSION,
				kind: 'response',
				id: 'fabricated',
				channel: 'camera-settings',
				payload: 'nope',
			})
		);
	});

	it('ignores unrelated postMessage traffic without throwing', () => {
		const { bridge, window } = makeBridge();
		bridge.start();
		for (const data of [null, 'hello', 42, { type: 'webpack' }, []]) {
			assert.doesNotThrow(() => window.deliver(data));
		}
	});
});

describe('IsolatedBridge - agent events', () => {
	it('routes an allowlisted event to its handler', () => {
		const { bridge, window } = makeBridge();
		const seen = [];
		bridge.on('speaking-state', (payload) => seen.push(payload));
		bridge.start();

		window.deliver({
			[MARKER]: SESSION,
			v: PROTOCOL_VERSION,
			kind: 'event',
			channel: 'speaking-state',
			payload: { speaking: true },
		});

		assert.deepStrictEqual(seen, [{ speaking: true }]);
	});

	it('refuses to register a handler for a channel that is not accepted', () => {
		const { bridge } = makeBridge();
		assert.throws(() => bridge.on('graph-api-get-mail', () => {}), /not accepted/);
	});

	it('requires the handler to be a function', () => {
		const { bridge } = makeBridge();
		assert.throws(() => bridge.on('speaking-state', 'nope'), /function/);
	});

	it('survives a handler that throws', () => {
		const { bridge, window } = makeBridge();
		bridge.on('speaking-state', () => {
			throw new Error('handler blew up');
		});
		bridge.start();

		assert.doesNotThrow(() =>
			window.deliver({
				[MARKER]: SESSION,
				v: PROTOCOL_VERSION,
				kind: 'event',
				channel: 'speaking-state',
				payload: null,
			})
		);
	});

	it('exposes the accepted channels as a copy', () => {
		const { bridge } = makeBridge();
		const channels = bridge.acceptedChannels;
		channels.add('injected');
		assert.ok(!bridge.acceptedChannels.has('injected'));
	});
});

describe('mainWorldAgent - buildAgentSource', () => {
	const config = { sessionId: SESSION, marker: MARKER, version: PROTOCOL_VERSION };

	it('produces a self-invoking source carrying the config', () => {
		const source = buildAgentSource(config);
		assert.match(source, /^\(function/);
		assert.ok(source.includes(SESSION));
		assert.ok(source.trimEnd().endsWith(');'));
	});

	it('escapes "<" so the config cannot close the script element', () => {
		const source = buildAgentSource({ ...config, sessionId: '</script><img src=x>' });
		assert.ok(!source.includes('</script>'));
		assert.ok(source.includes('\\u003c'));
	});

	it('validates its config', () => {
		assert.throws(() => buildAgentSource({ ...config, sessionId: '' }), /sessionId/);
		assert.throws(() => buildAgentSource({ ...config, marker: '' }), /marker/);
		assert.throws(() => buildAgentSource({ ...config, version: 1.5 }), /version/);
		assert.throws(() => buildAgentSource(null), /sessionId/);
	});
});

describe('injectAgent', () => {
	function createFakeDocument() {
		const appended = [];
		const head = {
			appendChild: (node) => {
				appended.push(node);
				return node;
			},
		};
		return {
			appended,
			head,
			documentElement: head,
			createElement: () => ({ textContent: '', remove() { this.removed = true; } }),
		};
	}

	it('appends a script with the agent source and removes the element afterwards', () => {
		const document = createFakeDocument();
		injectAgent(document, 'console.log(1)');

		assert.strictEqual(document.appended.length, 1);
		assert.strictEqual(document.appended[0].textContent, 'console.log(1)');
		assert.strictEqual(document.appended[0].removed, true);
	});

	it('throws when there is nowhere to inject', () => {
		assert.throws(
			() => injectAgent({ createElement: () => ({}) }, 'x'),
			/no document element/
		);
	});
});
