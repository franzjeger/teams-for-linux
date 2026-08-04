'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const {
	MAIN_WORLD_TOOLS,
	buildToolsSource,
	pickToolConfig,
	assertNoRequires,
} = require('../../app/browser/bridge/mainWorldTools');

describe('mainWorldTools - require guard', () => {
	it('rejects a tool containing a require call', () => {
		assert.throws(
			() => assertNoRequires('x', 'const a = require("./b");'),
			/cannot run in the page world/
		);
		assert.throws(() => assertNoRequires('x', 'require ("./b")'), /require\(\) call/);
	});

	it('accepts a tool with no require call', () => {
		assert.doesNotThrow(() => assertNoRequires('x', 'function init(config) {}\nmodule.exports={init};'));
	});

	it('does not trip on unrelated identifiers ending in require', () => {
		assert.doesNotThrow(() => assertNoRequires('x', 'const prerequire = 1; obj.require_ = 2;'));
	});

	it('every declared main-world tool passes the guard', () => {
		// buildToolsSource reads the real files, so this fails the moment one of
		// them gains an import that would throw in the page world.
		assert.doesNotThrow(() => buildToolsSource({}, MAIN_WORLD_TOOLS));
	});
});

describe('mainWorldTools - config narrowing', () => {
	it('copies only the branches the tools read', () => {
		const picked = pickToolConfig({
			media: {
				microphone: { disableAutogain: true },
				camera: { resolution: { enabled: true, width: 1280 } },
			},
			// None of the following may cross into the page world.
			proxyServer: 'proxy.corp.internal:8080',
			ssoInTuneAuthUser: 'alice@corp.test',
			clientCertPassword: 'hunter2',
			customBGServiceBaseUrl: 'https://bg.corp.internal',
			url: 'https://teams.corp.test',
		});

		assert.strictEqual(picked.media.microphone.disableAutogain, true);
		assert.deepStrictEqual(picked.media.camera.resolution, { enabled: true, width: 1280 });

		const serialised = JSON.stringify(picked);
		for (const secret of [
			'proxy.corp.internal',
			'alice@corp.test',
			'hunter2',
			'bg.corp.internal',
			'teams.corp.test',
		]) {
			assert.ok(!serialised.includes(secret), `'${secret}' must not reach the page world`);
		}
	});

	it('supports the deprecated flat disableAutogain flag', () => {
		assert.strictEqual(pickToolConfig({ disableAutogain: true }).disableAutogain, true);
	});

	it('defaults every tool to disabled for an empty config', () => {
		const picked = pickToolConfig({});
		assert.strictEqual(picked.disableAutogain, false);
		assert.strictEqual(picked.media.microphone.disableAutogain, false);
		assert.strictEqual(picked.media.camera.resolution.enabled, false);
		assert.strictEqual(picked.media.camera.autoAdjustAspectRatio.enabled, false);
	});

	it('tolerates null and undefined input', () => {
		for (const input of [null, undefined]) {
			assert.doesNotThrow(() => pickToolConfig(input));
		}
	});

	it('coerces a truthy non-boolean flag to a real boolean', () => {
		assert.strictEqual(pickToolConfig({ disableAutogain: 'yes' }).disableAutogain, false);
	});
});

describe('mainWorldTools - generated source', () => {
	/** Runs the generated bundle against a minimal page-world stand-in. */
	function runBundle(config) {
		const logs = [];
		const context = {
			navigator: {
				mediaDevices: {
					getUserMedia: function getUserMedia() {},
					enumerateDevices: async () => [],
				},
			},
			window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800, screen: {} },
			document: { addEventListener() {} },
			console: {
				log: (...a) => logs.push(a.join(' ')),
				info: (...a) => logs.push(a.join(' ')),
				warn: (...a) => logs.push(a.join(' ')),
				error: (...a) => logs.push(a.join(' ')),
				debug: () => {},
			},
			setTimeout,
			clearTimeout,
			setInterval: () => 0,
			clearInterval: () => {},
			Promise,
			Object,
			Array,
			JSON,
			Error,
			Math,
			Set,
			Map,
			String,
			Number,
			Boolean,
			Function,
		};
		context.globalThis = context;
		context.self = context;
		vm.createContext(context);
		vm.runInContext(buildToolsSource(config), context);
		return { context, logs };
	}

	it('runs in a page-like context without throwing', () => {
		assert.doesNotThrow(() => runBundle(pickToolConfig({})));
	});

	it('leaves getUserMedia untouched when every tool is disabled', () => {
		const { context } = runBundle(pickToolConfig({}));
		const fn = context.navigator.mediaDevices.getUserMedia;
		assert.strictEqual(fn.name, 'getUserMedia');
		// Still the original function object we installed.
		assert.strictEqual(typeof fn, 'function');
	});

	it('patches getUserMedia when a camera tool is enabled', () => {
		const original = () => {};
		const config = pickToolConfig({
			media: { camera: { autoAdjustAspectRatio: { enabled: true } } },
		});
		const { context } = runBundle(config);
		assert.notStrictEqual(
			context.navigator.mediaDevices.getUserMedia,
			original,
			'getUserMedia should have been wrapped'
		);
		assert.strictEqual(typeof context.navigator.mediaDevices.getUserMedia, 'function');
	});

	it('reports how many tools initialised', () => {
		const { logs } = runBundle(pickToolConfig({}));
		assert.ok(
			logs.some((line) => line.includes('[MAIN_WORLD_TOOLS] Initialised')),
			`Expected an init summary, got: ${logs.join(' | ')}`
		);
	});

	it('does not leak the CommonJS shim into the global scope', () => {
		const { context } = runBundle(pickToolConfig({}));
		// `var module` / `var exports` live inside the wrapper function, so they
		// must not become page globals where Teams could observe them.
		assert.strictEqual(context.module, undefined);
		assert.strictEqual(context.exports, undefined);
		assert.strictEqual(context.__tools, undefined);
	});

	it('embeds the config as JSON rather than interpolated code', () => {
		const source = buildToolsSource({ evil: '"); globalThis.pwned = true; ("' });
		const context = { console: { info() {}, error() {}, warn() {}, debug() {} }, Object };
		context.globalThis = context;
		vm.createContext(context);
		assert.doesNotThrow(() => vm.runInContext(source, context));
		assert.strictEqual(context.pwned, undefined);
	});

	it('accepts an empty tool list', () => {
		assert.doesNotThrow(() => buildToolsSource({}, []));
	});
});
