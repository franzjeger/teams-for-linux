'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
	MARKER,
	PROTOCOL_VERSION,
	KIND_REQUEST,
	KIND_RESPONSE,
	KIND_EVENT,
	createEnvelope,
	validateInbound,
	isSameWindowEvent,
	hasUnsafeKeys,
} = require('../../app/browser/bridge/protocol');

const SESSION = 'session-abc';

function envelope(overrides = {}) {
	return {
		[MARKER]: SESSION,
		v: PROTOCOL_VERSION,
		kind: KIND_EVENT,
		channel: 'speaking-state',
		payload: { speaking: true },
		...overrides,
	};
}

function options(overrides = {}) {
	return {
		sessionId: SESSION,
		acceptedChannels: ['speaking-state', 'camera-settings'],
		...overrides,
	};
}

describe('Bridge protocol - createEnvelope', () => {
	it('builds a request carrying marker, version, id and channel', () => {
		const e = createEnvelope({
			sessionId: SESSION,
			kind: KIND_REQUEST,
			id: 'r1',
			channel: 'camera-settings',
			payload: { deviceId: 'x' },
		});

		assert.strictEqual(e[MARKER], SESSION);
		assert.strictEqual(e.v, PROTOCOL_VERSION);
		assert.strictEqual(e.kind, KIND_REQUEST);
		assert.strictEqual(e.id, 'r1');
		assert.strictEqual(e.channel, 'camera-settings');
		assert.deepStrictEqual(e.payload, { deviceId: 'x' });
	});

	it('omits the id for events and normalises a missing payload to null', () => {
		const e = createEnvelope({ sessionId: SESSION, kind: KIND_EVENT, channel: 'speaking-state' });
		assert.ok(!('id' in e));
		assert.strictEqual(e.payload, null);
	});

	it('requires an id for requests and responses', () => {
		for (const kind of [KIND_REQUEST, KIND_RESPONSE]) {
			assert.throws(
				() => createEnvelope({ sessionId: SESSION, kind, channel: 'c' }),
				/id is required/
			);
		}
	});

	it('rejects a missing session id, unknown kind or empty channel', () => {
		assert.throws(() => createEnvelope({ sessionId: '', kind: KIND_EVENT, channel: 'c' }), /sessionId/);
		assert.throws(() => createEnvelope({ sessionId: SESSION, kind: 'evil', channel: 'c' }), /unknown kind/);
		assert.throws(() => createEnvelope({ sessionId: SESSION, kind: KIND_EVENT, channel: '' }), /channel/);
	});
});

describe('Bridge protocol - validateInbound rejects non-bridge traffic', () => {
	it('rejects non-objects without throwing', () => {
		for (const input of [null, undefined, 'string', 42, [], true]) {
			assert.strictEqual(validateInbound(input, options()).ok, false);
		}
	});

	it('rejects a message with a different or absent session id', () => {
		assert.strictEqual(validateInbound(envelope({ [MARKER]: 'other' }), options()).ok, false);
		const noMarker = envelope();
		delete noMarker[MARKER];
		assert.strictEqual(validateInbound(noMarker, options()).ok, false);
	});

	it('rejects a protocol version mismatch', () => {
		const r = validateInbound(envelope({ v: PROTOCOL_VERSION + 1 }), options());
		assert.strictEqual(r.ok, false);
		assert.match(r.reason, /version/);
	});

	it('rejects objects with a non-standard prototype', () => {
		const crafted = Object.create({ evil: true });
		Object.assign(crafted, envelope());
		assert.strictEqual(validateInbound(crafted, options()).ok, false);
	});
});

describe('Bridge protocol - validateInbound enforces direction', () => {
	it('never accepts a request inbound, so the page cannot drive the isolated world', () => {
		const r = validateInbound(
			envelope({ kind: KIND_REQUEST, id: 'r1' }),
			options({ pendingIds: new Set(['r1']) })
		);
		assert.strictEqual(r.ok, false);
		assert.match(r.reason, /not accepted inbound/);
	});

	it('rejects unknown kinds', () => {
		for (const kind of ['evil', '', null, 42, undefined]) {
			assert.strictEqual(validateInbound(envelope({ kind }), options()).ok, false);
		}
	});

	it('accepts events on an allowlisted channel', () => {
		const r = validateInbound(envelope(), options());
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.kind, KIND_EVENT);
		assert.strictEqual(r.id, null);
		assert.deepStrictEqual(r.payload, { speaking: true });
	});
});

describe('Bridge protocol - channel allowlist is the real control', () => {
	it('rejects a channel that was not opted into', () => {
		const r = validateInbound(envelope({ channel: 'graph-api-get-mail' }), options());
		assert.strictEqual(r.ok, false);
		assert.match(r.reason, /channel not accepted/);
	});

	it('rejects a non-string channel', () => {
		for (const channel of [null, 42, {}, undefined, ['speaking-state']]) {
			assert.strictEqual(validateInbound(envelope({ channel }), options()).ok, false);
		}
	});

	it('accepts either a Set or an array of channels', () => {
		assert.strictEqual(
			validateInbound(envelope(), options({ acceptedChannels: new Set(['speaking-state']) })).ok,
			true
		);
		assert.strictEqual(
			validateInbound(envelope(), options({ acceptedChannels: ['speaking-state'] })).ok,
			true
		);
	});

	it('rejects everything when no channels are accepted', () => {
		assert.strictEqual(validateInbound(envelope(), options({ acceptedChannels: [] })).ok, false);
	});
});

describe('Bridge protocol - response correlation', () => {
	const responseOpts = (pending) =>
		options({ pendingIds: new Set(pending) });

	it('accepts a response that answers a pending request', () => {
		const r = validateInbound(
			envelope({ kind: KIND_RESPONSE, id: 'r1' }),
			responseOpts(['r1'])
		);
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.id, 'r1');
	});

	it('rejects an unsolicited response', () => {
		const r = validateInbound(
			envelope({ kind: KIND_RESPONSE, id: 'never-issued' }),
			responseOpts(['r1'])
		);
		assert.strictEqual(r.ok, false);
		assert.match(r.reason, /pending request/);
	});

	it('rejects a replayed response once the id is no longer pending', () => {
		const message = envelope({ kind: KIND_RESPONSE, id: 'r1' });
		assert.strictEqual(validateInbound(message, responseOpts(['r1'])).ok, true);
		// Simulates the bridge having deleted the id after the first answer.
		assert.strictEqual(validateInbound(message, responseOpts([])).ok, false);
	});

	it('rejects a response with a missing or non-string id', () => {
		for (const id of [undefined, '', null, 42]) {
			const r = validateInbound(envelope({ kind: KIND_RESPONSE, id }), responseOpts(['r1']));
			assert.strictEqual(r.ok, false);
		}
	});
});

describe('Bridge protocol - payload validation', () => {
	it('runs the validator registered for the channel', () => {
		const validators = { 'speaking-state': (p) => typeof p?.speaking === 'boolean' };

		assert.strictEqual(validateInbound(envelope(), options({ validators })).ok, true);
		assert.strictEqual(
			validateInbound(envelope({ payload: { speaking: 'yes' } }), options({ validators })).ok,
			false
		);
	});

	it('treats a throwing validator as a rejection rather than crashing', () => {
		const validators = {
			'speaking-state': () => {
				throw new Error('boom');
			},
		};
		const r = validateInbound(envelope(), options({ validators }));
		assert.strictEqual(r.ok, false);
		assert.match(r.reason, /threw/);
	});

	it('requires a validator to return exactly true', () => {
		for (const value of [1, 'yes', {}, [], 'true']) {
			const validators = { 'speaking-state': () => value };
			assert.strictEqual(validateInbound(envelope(), options({ validators })).ok, false);
		}
	});

	it('does not pick up validators from the prototype chain', () => {
		const validators = Object.create({ 'speaking-state': () => false });
		// Inherited validator must be ignored, so the message is accepted.
		assert.strictEqual(validateInbound(envelope(), options({ validators })).ok, true);
	});

	it('accepts a channel with no validator registered', () => {
		assert.strictEqual(validateInbound(envelope(), options({ validators: {} })).ok, true);
	});
});

describe('Bridge protocol - prototype pollution guards', () => {
	it('rejects payloads carrying unsafe keys at any depth', () => {
		const payloads = [
			JSON.parse('{"__proto__":{"polluted":true}}'),
			JSON.parse('{"a":{"b":{"constructor":{"x":1}}}}'),
			JSON.parse('{"list":[{"prototype":{}}]}'),
		];
		for (const payload of payloads) {
			const r = validateInbound(envelope({ payload }), options());
			assert.strictEqual(r.ok, false, `Expected rejection for ${JSON.stringify(payload)}`);
			assert.match(r.reason, /unsafe keys/);
		}
		assert.strictEqual({}.polluted, undefined);
	});

	it('allows ordinary nested payloads', () => {
		const payload = { a: 1, b: { c: [1, 2, { d: 'ok' }] } };
		assert.strictEqual(validateInbound(envelope({ payload }), options()).ok, true);
	});

	it('rejects payloads nested beyond the depth limit rather than recursing forever', () => {
		let deep = {};
		let cursor = deep;
		for (let i = 0; i < 40; i++) {
			cursor.next = {};
			cursor = cursor.next;
		}
		assert.strictEqual(hasUnsafeKeys(deep), true);
	});
});

describe('Bridge protocol - isSameWindowEvent', () => {
	const win = { name: 'page-window' };

	it('accepts an event from the same window and origin', () => {
		const ok = isSameWindowEvent(
			{ source: win, origin: 'https://teams.microsoft.com' },
			{ expectedSource: win, expectedOrigin: 'https://teams.microsoft.com' }
		);
		assert.strictEqual(ok, true);
	});

	it('rejects events from another window, such as an embedded frame', () => {
		const ok = isSameWindowEvent(
			{ source: { name: 'iframe' }, origin: 'https://teams.microsoft.com' },
			{ expectedSource: win, expectedOrigin: 'https://teams.microsoft.com' }
		);
		assert.strictEqual(ok, false);
	});

	it('rejects a mismatched origin', () => {
		const ok = isSameWindowEvent(
			{ source: win, origin: 'https://evil.test' },
			{ expectedSource: win, expectedOrigin: 'https://teams.microsoft.com' }
		);
		assert.strictEqual(ok, false);
	});

	it('rejects the opaque "null" origin used by sandboxed and data: documents', () => {
		for (const origin of ['null', '', undefined, null, 42]) {
			const ok = isSameWindowEvent(
				{ source: win, origin },
				{ expectedSource: win, expectedOrigin: origin }
			);
			assert.strictEqual(ok, false, `Expected rejection for origin ${JSON.stringify(origin)}`);
		}
	});

	it('rejects a missing event without throwing', () => {
		assert.strictEqual(
			isSameWindowEvent(null, { expectedSource: win, expectedOrigin: 'https://x.test' }),
			false
		);
	});
});
