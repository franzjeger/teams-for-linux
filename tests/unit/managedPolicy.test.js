'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
	POLICY_KEY,
	buildPolicy,
	mergeWithPolicy,
	enforcePolicy,
	getPath,
	setPath,
	deepEquals,
} = require('../../app/config/managedPolicy');

describe('Managed policy - buildPolicy', () => {
	it('reports unmanaged when no policy section is present', () => {
		const policy = buildPolicy({ url: 'https://example.test' });
		assert.strictEqual(policy.isManaged, false);
		assert.deepStrictEqual(policy.lockedSettings, []);
	});

	it('reports unmanaged for non-object input', () => {
		for (const input of [null, undefined, 'string', 42, []]) {
			assert.strictEqual(buildPolicy(input).isManaged, false);
		}
	});

	it('collects the declared locked settings and their values', () => {
		const policy = buildPolicy({
			[POLICY_KEY]: { lockedSettings: ['url', 'disableAutoUpdate'] },
			url: 'https://teams.corp.test',
			disableAutoUpdate: true,
			appTitle: 'Ignored',
		});

		assert.strictEqual(policy.isManaged, true);
		assert.deepStrictEqual(policy.lockedSettings, ['url', 'disableAutoUpdate']);
		assert.deepStrictEqual(policy.values, {
			url: 'https://teams.corp.test',
			disableAutoUpdate: true,
		});
	});

	it('supports dotted paths for nested settings', () => {
		const policy = buildPolicy({
			[POLICY_KEY]: { lockedSettings: ['mqtt.enabled'] },
			mqtt: { enabled: false, clientId: 'corp' },
		});

		assert.deepStrictEqual(policy.values, { mqtt: { enabled: false } });
	});

	it('locks every declared system setting when lockAll is set', () => {
		const policy = buildPolicy({
			[POLICY_KEY]: { lockAll: true },
			url: 'https://teams.corp.test',
			disableDevTools: true,
		});

		assert.strictEqual(policy.lockAll, true);
		assert.deepStrictEqual(policy.lockedSettings.sort(), ['disableDevTools', 'url']);
		assert.strictEqual(policy.values.url, 'https://teams.corp.test');
	});

	it('never treats the policy section itself as a locked setting', () => {
		const policy = buildPolicy({ [POLICY_KEY]: { lockAll: true }, url: 'x' });
		assert.ok(!policy.lockedSettings.includes(POLICY_KEY));
	});

	it('ignores malformed lockedSettings entries', () => {
		const policy = buildPolicy({
			[POLICY_KEY]: { lockedSettings: ['url', '', null, 42, {}] },
			url: 'https://teams.corp.test',
		});

		assert.deepStrictEqual(policy.lockedSettings, ['url']);
	});

	it('deduplicates repeated locked settings', () => {
		const policy = buildPolicy({
			[POLICY_KEY]: { lockedSettings: ['url', 'url'] },
			url: 'https://teams.corp.test',
		});

		assert.deepStrictEqual(policy.lockedSettings, ['url']);
	});
});

describe('Managed policy - mergeWithPolicy', () => {
	it('keeps user precedence for unlocked settings', () => {
		const system = { url: 'https://system.test', appTitle: 'System' };
		const user = { appTitle: 'User' };
		const policy = buildPolicy(system);

		const { merged } = mergeWithPolicy(system, user, policy);
		assert.strictEqual(merged.appTitle, 'User');
		assert.strictEqual(merged.url, 'https://system.test');
	});

	it('pins locked settings to the system value', () => {
		const system = {
			[POLICY_KEY]: { lockedSettings: ['url'] },
			url: 'https://teams.corp.test',
		};
		const user = { url: 'https://evil.test' };
		const policy = buildPolicy(system);

		const { merged, blocked } = mergeWithPolicy(system, user, policy);
		assert.strictEqual(merged.url, 'https://teams.corp.test');
		assert.deepStrictEqual(blocked, ['url']);
	});

	it('does not report a blocked override when the user value matches policy', () => {
		const system = {
			[POLICY_KEY]: { lockedSettings: ['url'] },
			url: 'https://teams.corp.test',
		};
		const user = { url: 'https://teams.corp.test' };
		const policy = buildPolicy(system);

		const { blocked } = mergeWithPolicy(system, user, policy);
		assert.deepStrictEqual(blocked, []);
	});

	it('strips the policy section from the merged config', () => {
		const system = { [POLICY_KEY]: { lockedSettings: ['url'] }, url: 'a' };
		const policy = buildPolicy(system);

		const { merged } = mergeWithPolicy(system, {}, policy);
		assert.ok(!(POLICY_KEY in merged));
	});

	it('ignores a policy section declared in the user config', () => {
		const system = {
			[POLICY_KEY]: { lockedSettings: ['disableDevTools'] },
			disableDevTools: true,
		};
		const user = {
			[POLICY_KEY]: { lockedSettings: [] },
			disableDevTools: false,
		};
		const policy = buildPolicy(system);

		const { merged, blocked } = mergeWithPolicy(system, user, policy);
		assert.strictEqual(merged.disableDevTools, true);
		assert.deepStrictEqual(blocked, ['disableDevTools']);
		assert.ok(!(POLICY_KEY in merged));
	});

	it('pins nested locked settings without discarding sibling user values', () => {
		const system = {
			[POLICY_KEY]: { lockedSettings: ['mqtt.enabled'] },
			mqtt: { enabled: false },
		};
		const user = { mqtt: { enabled: true, clientId: 'user-choice' } };
		const policy = buildPolicy(system);

		const { merged, blocked } = mergeWithPolicy(system, user, policy);
		assert.strictEqual(merged.mqtt.enabled, false);
		assert.strictEqual(merged.mqtt.clientId, 'user-choice');
		assert.deepStrictEqual(blocked, ['mqtt.enabled']);
	});
});

describe('Managed policy - enforcePolicy', () => {
	it('reverts values changed after config merge (env vars, CLI)', () => {
		const policy = buildPolicy({
			[POLICY_KEY]: { lockedSettings: ['url', 'disableDevTools'] },
			url: 'https://teams.corp.test',
			disableDevTools: true,
		});

		const config = { url: 'https://cli-override.test', disableDevTools: false };
		const corrected = enforcePolicy(config, policy);

		assert.deepStrictEqual(corrected.sort(), ['disableDevTools', 'url']);
		assert.strictEqual(config.url, 'https://teams.corp.test');
		assert.strictEqual(config.disableDevTools, true);
	});

	it('returns nothing to correct when values already match', () => {
		const policy = buildPolicy({
			[POLICY_KEY]: { lockedSettings: ['url'] },
			url: 'https://teams.corp.test',
		});

		const config = { url: 'https://teams.corp.test' };
		assert.deepStrictEqual(enforcePolicy(config, policy), []);
	});

	it('is a no-op for an unmanaged policy', () => {
		const config = { url: 'https://user.test' };
		assert.deepStrictEqual(enforcePolicy(config, buildPolicy({})), []);
		assert.strictEqual(config.url, 'https://user.test');
	});

	it('restores a locked setting that was deleted downstream', () => {
		const policy = buildPolicy({
			[POLICY_KEY]: { lockedSettings: ['disableAutoUpdate'] },
			disableAutoUpdate: true,
		});

		const config = {};
		assert.deepStrictEqual(enforcePolicy(config, policy), ['disableAutoUpdate']);
		assert.strictEqual(config.disableAutoUpdate, true);
	});
});

describe('Managed policy - path helpers reject prototype pollution', () => {
	it('refuses to read through unsafe keys', () => {
		assert.deepStrictEqual(getPath({}, '__proto__.polluted'), {
			found: false,
			value: undefined,
		});
	});

	it('refuses to write through unsafe keys', () => {
		const target = {};
		assert.strictEqual(setPath(target, '__proto__.polluted', true), false);
		assert.strictEqual(setPath(target, 'constructor.polluted', true), false);
		assert.strictEqual(setPath(target, 'a..b', true), false);
		assert.strictEqual({}.polluted, undefined);
	});

	it('does not pollute Object.prototype through a crafted policy', () => {
		const policy = buildPolicy({
			[POLICY_KEY]: { lockedSettings: ['__proto__.polluted'] },
		});
		const config = {};
		enforcePolicy(config, policy);
		assert.strictEqual({}.polluted, undefined);
	});
});

describe('Managed policy - deepEquals', () => {
	it('compares primitives, arrays and nested objects', () => {
		assert.strictEqual(deepEquals(1, 1), true);
		assert.strictEqual(deepEquals('a', 'b'), false);
		assert.strictEqual(deepEquals([1, 2], [1, 2]), true);
		assert.strictEqual(deepEquals([1, 2], [2, 1]), false);
		assert.strictEqual(deepEquals({ a: { b: 1 } }, { a: { b: 1 } }), true);
		assert.strictEqual(deepEquals({ a: 1 }, { a: 1, b: 2 }), false);
	});

	it('ignores key order', () => {
		assert.strictEqual(deepEquals({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
	});

	it('does not treat null and objects as equal', () => {
		assert.strictEqual(deepEquals(null, {}), false);
		assert.strictEqual(deepEquals({}, null), false);
	});
});
