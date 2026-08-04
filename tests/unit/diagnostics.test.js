'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
	redactConfig,
	REDACTED_CONFIG_KEYS,
} = require('../../app/diagnostics');

describe('Diagnostics - config redaction', () => {
	it('redacts every declared sensitive key', () => {
		const config = {
			clientCertPassword: 'hunter2',
			clientCertPath: '/home/alice/cert.p12',
			ssoBasicAuthUser: 'alice',
			ssoBasicAuthPasswordCommand: 'pass show teams',
			ssoInTuneAuthUser: 'alice@corp.test',
			authServerWhitelist: '*.corp.internal',
			proxyServer: 'proxy.corp.internal:8080',
			customBGServiceBaseUrl: 'https://backgrounds.corp.internal',
			customCACertsFingerprints: ['AA:BB:CC'],
			mqtt: {
				url: 'mqtts://broker.corp.internal:8883',
				username: 'alice',
				password: 'hunter2',
				clientId: 'alice-laptop',
				enabled: true,
			},
			graphApi: { clientId: 'abc', tenantId: 'def', enabled: true },
		};

		const redacted = redactConfig(config);

		for (const dottedPath of REDACTED_CONFIG_KEYS) {
			const value = dottedPath
				.split('.')
				.reduce((cursor, key) => (cursor == null ? cursor : cursor[key]), redacted);
			assert.strictEqual(
				value,
				'[REDACTED]',
				`Expected '${dottedPath}' to be redacted, got ${JSON.stringify(value)}`
			);
		}
	});

	it('keeps non-sensitive settings intact', () => {
		const redacted = redactConfig({
			appTitle: 'Microsoft Teams',
			closeAppOnCross: true,
			mqtt: { enabled: true, password: 'secret' },
			graphApi: { enabled: false, clientId: 'abc' },
		});

		assert.strictEqual(redacted.appTitle, 'Microsoft Teams');
		assert.strictEqual(redacted.closeAppOnCross, true);
		assert.strictEqual(redacted.mqtt.enabled, true);
		assert.strictEqual(redacted.graphApi.enabled, false);
	});

	it('does not mutate the config it was given', () => {
		const config = { clientCertPassword: 'hunter2', mqtt: { password: 'p' } };
		redactConfig(config);

		assert.strictEqual(config.clientCertPassword, 'hunter2');
		assert.strictEqual(config.mqtt.password, 'p');
	});

	it('tolerates missing and partially present nested sections', () => {
		const redacted = redactConfig({ appTitle: 'Teams' });
		assert.strictEqual(redacted.appTitle, 'Teams');
		assert.strictEqual(redacted.mqtt, undefined);

		const partial = redactConfig({ mqtt: { enabled: false } });
		assert.strictEqual(partial.mqtt.enabled, false);
		assert.strictEqual(partial.mqtt.password, undefined);
	});

	it('does not invent keys that were absent', () => {
		const redacted = redactConfig({ mqtt: { enabled: true } });
		assert.ok(!Object.hasOwn(redacted.mqtt, 'password'));
		assert.ok(!Object.hasOwn(redacted, 'clientCertPassword'));
	});

	it('returns an empty object for non-object input', () => {
		for (const input of [null, undefined, 'string', 42, []]) {
			assert.deepStrictEqual(redactConfig(input), {});
		}
	});

	it('survives a config carrying non-serialisable values', () => {
		const config = {
			appTitle: 'Teams',
			clientCertPassword: 'hunter2',
			onSomething: () => {},
		};

		const redacted = redactConfig(config);
		assert.strictEqual(redacted.appTitle, 'Teams');
		assert.strictEqual(redacted.clientCertPassword, '[REDACTED]');
	});

	it('does not leak a redacted value through a nested reference', () => {
		const shared = { password: 'hunter2' };
		const redacted = redactConfig({ mqtt: shared, copy: shared });

		assert.strictEqual(redacted.mqtt.password, '[REDACTED]');
		assert.strictEqual(shared.password, 'hunter2');
	});
});
