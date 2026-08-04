'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { IsolatedBridge } = require('../../app/browser/bridge/isolatedBridge');
const { buildAgentSource } = require('../../app/browser/bridge/mainWorldAgent');
const { MARKER, PROTOCOL_VERSION } = require('../../app/browser/bridge/protocol');

const ORIGIN = 'https://teams.microsoft.com';
const SESSION = 'interop-session';

/**
 * Wires a real IsolatedBridge to the real agent source running in a VM context,
 * with a shared fake window in between.
 *
 * This is the test that matters: the two halves are written against the same
 * protocol but never import each other, so only an end-to-end round trip proves
 * they actually agree.
 */
function createHarness({ sessionId = SESSION, origin = ORIGIN } = {}) {
	const preloadListeners = [];
	const agentListeners = [];

	// Both worlds share one window object, exactly as they do in the renderer.
	const sharedWindow = {
		location: { origin },
		addEventListener: (type, fn) => {
			if (type === 'message') preloadListeners.push(fn);
		},
		removeEventListener: (type, fn) => {
			const i = preloadListeners.indexOf(fn);
			if (i >= 0) preloadListeners.splice(i, 1);
		},
		// A post from the preload side is observed by both sides, like the real
		// window.postMessage, which dispatches to every listener on the window.
		postMessage: (data) => {
			queueMicrotask(() => dispatch(data));
		},
	};

	// Set once the context exists. Inside a vm context `globalThis` is a proxy,
	// not the object handed to createContext, and the agent compares
	// `event.source !== globalThis` by identity - so the proxy is what must be
	// presented as the source.
	let innerGlobal = null;

	function dispatch(data) {
		// Real postMessage structured-clones its argument, and the clone is
		// created in the RECEIVING realm. Cloning here matters: without it the
		// agent's replies keep the VM realm's Object.prototype and are correctly
		// rejected by the bridge's plain-object check, which would be a test
		// artefact rather than a real defect.
		const clone = () => structuredClone(data);

		// The agent and the preload both listen on the same window, each seeing
		// itself as the source, exactly as window.postMessage behaves.
		for (const fn of [...agentListeners]) fn({ data: clone(), source: innerGlobal, origin });
		for (const fn of [...preloadListeners]) fn({ data: clone(), source: sharedWindow, origin });
	}

	// The VM context stands in for the page world's global object.
	const agentGlobal = {
		location: { origin },
		addEventListener: (type, fn) => {
			if (type === 'message') agentListeners.push(fn);
		},
		postMessage: (data) => {
			queueMicrotask(() => dispatch(data));
		},
		queueMicrotask,
		Object,
		JSON,
		String,
		Error,
		Promise,
		console: { log() {}, warn() {}, error() {} },
	};
	// Deliberately not setting agentGlobal.globalThis: an own property of that
	// name shadows the context's real globalThis, so the agent's
	// `event.source !== globalThis` check would compare against the wrong object.

	vm.createContext(agentGlobal);
	innerGlobal = vm.runInContext('globalThis', agentGlobal);
	vm.runInContext(
		buildAgentSource({ sessionId, marker: MARKER, version: PROTOCOL_VERSION }),
		agentGlobal
	);

	const agentApi = agentGlobal[`__tflAgent_${sessionId}`];

	const bridge = new IsolatedBridge({
		window: sharedWindow,
		sessionId,
		acceptedChannels: ['echo', 'boom', 'slow', 'speaking-state'],
	});
	bridge.start();

	return { bridge, agentApi, agentGlobal, dispatch };
}

describe('Bridge interop - real agent against real bridge', () => {
	it('exposes the agent api under a session-scoped global', () => {
		const { agentApi, agentGlobal } = createHarness();
		assert.strictEqual(typeof agentApi.register, 'function');
		assert.strictEqual(typeof agentApi.emit, 'function');
		// Not enumerable, so it does not show up in a casual scan of globals.
		assert.ok(!Object.keys(agentGlobal).includes(`__tflAgent_${SESSION}`));
	});

	it('completes a request/response round trip', async () => {
		const { bridge, agentApi } = createHarness();
		agentApi.register('echo', (payload) => ({ echoed: payload }));

		const result = await bridge.request('echo', { hello: 'world' });
		assert.deepStrictEqual(result, { echoed: { hello: 'world' } });
	});

	it('awaits an async capability', async () => {
		const { bridge, agentApi } = createHarness();
		agentApi.register('slow', async (payload) => {
			await new Promise((r) => setTimeout(r, 5));
			return payload * 2;
		});

		assert.strictEqual(await bridge.request('slow', 21), 42);
	});

	it('surfaces a capability error as a rejection without leaking the stack', async () => {
		const { bridge, agentApi } = createHarness();
		agentApi.register('boom', () => {
			throw new Error('capability exploded');
		});

		await assert.rejects(() => bridge.request('boom', null), (error) => {
			assert.match(error.message, /capability exploded/);
			assert.ok(!error.message.includes('at '), 'stack must not cross the boundary');
			return true;
		});
	});

	it('rejects a request for a capability the agent never registered', async () => {
		const { bridge } = createHarness();
		await assert.rejects(() => bridge.request('echo', {}), /unknown capability/);
	});

	it('normalises an undefined return to null rather than hanging', async () => {
		const { bridge, agentApi } = createHarness();
		agentApi.register('echo', () => undefined);
		assert.strictEqual(await bridge.request('echo', {}), null);
	});

	it('delivers an agent-initiated event to the bridge handler', async () => {
		const { bridge, agentApi } = createHarness();
		const seen = [];
		bridge.on('speaking-state', (payload) => seen.push(payload));

		agentApi.emit('speaking-state', { speaking: true });
		await new Promise((r) => setTimeout(r, 5));

		assert.deepStrictEqual(seen, [{ speaking: true }]);
	});

	it('drops an event on a channel the bridge did not accept', async () => {
		const { bridge, agentApi } = createHarness();
		assert.throws(() => bridge.on('graph-api-get-mail', () => {}), /not accepted/);

		// The agent can still emit it; the bridge must simply ignore it.
		assert.doesNotThrow(() => agentApi.emit('graph-api-get-mail', { secret: true }));
		await new Promise((r) => setTimeout(r, 5));
	});

	it('ignores a request forged with the wrong session id', async () => {
		const { agentApi, dispatch } = createHarness();
		let called = false;
		agentApi.register('echo', () => {
			called = true;
			return 'ran';
		});

		dispatch({
			[MARKER]: 'not-our-session',
			v: PROTOCOL_VERSION,
			kind: 'request',
			id: 'x1',
			channel: 'echo',
			payload: {},
		});
		await new Promise((r) => setTimeout(r, 5));

		assert.strictEqual(called, false, 'agent must not run capabilities for foreign sessions');
	});

	it('ignores a request with a mismatched protocol version', async () => {
		const { agentApi, dispatch } = createHarness();
		let called = false;
		agentApi.register('echo', () => {
			called = true;
		});

		dispatch({
			[MARKER]: SESSION,
			v: PROTOCOL_VERSION + 1,
			kind: 'request',
			id: 'x1',
			channel: 'echo',
			payload: {},
		});
		await new Promise((r) => setTimeout(r, 5));

		assert.strictEqual(called, false);
	});

	it('does not let the agent consume its own responses as requests', async () => {
		const { bridge, agentApi } = createHarness();
		let invocations = 0;
		agentApi.register('echo', () => {
			invocations += 1;
			return 'ok';
		});

		await bridge.request('echo', {});
		await new Promise((r) => setTimeout(r, 5));

		assert.strictEqual(invocations, 1, 'a response must not loop back as a new request');
	});

	it('validates its own registration inputs', () => {
		const { agentApi } = createHarness();
		assert.throws(() => agentApi.register('', () => {}), /channel/);
		assert.throws(() => agentApi.register('echo', 'nope'), /function/);
	});
});
