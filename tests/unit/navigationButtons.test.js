'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

/**
 * Minimal DOM stub. navigationButtons only needs element creation, a couple of
 * lookups and event listener registration, so a full DOM implementation would
 * be more machinery than the test needs.
 */
function createElementStub(tagName) {
	const element = {
		tagName,
		id: '',
		className: '',
		title: '',
		disabled: false,
		textContent: '',
		children: [],
		attributes: {},
		listeners: {},
		classList: {
			toggled: {},
			toggle(name, force) {
				this.toggled[name] = force;
			},
		},
		setAttribute(name, value) {
			this.attributes[name] = value;
		},
		appendChild(child) {
			this.children.push(child);
			return child;
		},
		addEventListener(type, listener) {
			(this.listeners[type] ??= []).push(listener);
		},
		click() {
			for (const listener of this.listeners.click ?? []) listener();
		},
	};
	return element;
}

function createDocumentStub() {
	const byId = new Map();
	const searchRegion = createElementStub('div');
	const inserted = [];

	searchRegion.parentNode = {
		insertBefore(node) {
			inserted.push(node);
			return node;
		},
	};

	return {
		inserted,
		body: createElementStub('body'),
		head: createElementStub('head'),
		createElement: (tag) => createElementStub(tag),
		createElementNS: (_ns, tag) => createElementStub(tag),
		getElementById: (id) => byId.get(id) ?? null,
		querySelector: (selector) =>
			selector === '[data-tid="search-f6-navigation-region"]' ? searchRegion : null,
		// Test helper: register the buttons the module looks up after injection.
		_register: (id, element) => byId.set(id, element),
	};
}

function createIpcStub() {
	const sent = [];
	const invoked = [];
	const listeners = new Map();
	return {
		sent,
		invoked,
		listeners,
		send: (channel, ...args) => sent.push({ channel, args }),
		invoke: (channel, ...args) => {
			invoked.push({ channel, args });
			return Promise.resolve({ canGoBack: true, canGoForward: false });
		},
		on: (channel, listener) => listeners.set(channel, listener),
	};
}

let NavigationButtons;
let originalDocument;

function loadModule() {
	delete require.cache[require.resolve('../../app/browser/tools/navigationButtons')];
	return require('../../app/browser/tools/navigationButtons');
}

describe('NavigationButtons - IPC wiring', () => {
	beforeEach(() => {
		originalDocument = globalThis.document;
	});

	afterEach(() => {
		globalThis.document = originalDocument;
	});

	function setup() {
		const doc = createDocumentStub();
		globalThis.document = doc;
		const ipc = createIpcStub();
		NavigationButtons = loadModule();
		NavigationButtons.init({}, ipc);

		// After injection the module looks the buttons up by id.
		const back = doc.inserted[0]?.children[0];
		const forward = doc.inserted[0]?.children[1];
		doc._register('tfl-nav-back', back);
		doc._register('tfl-nav-forward', forward);

		return { doc, ipc, back, forward };
	}

	it('injects a back and a forward button before the search region', () => {
		const { doc } = setup();
		assert.strictEqual(doc.inserted.length, 1);
		assert.strictEqual(doc.inserted[0].id, 'tfl-nav-buttons-container');
		assert.strictEqual(doc.inserted[0].children.length, 2);
	});

	it('sends navigate-back over IPC rather than through a page global', () => {
		const { ipc, doc } = setup();
		// Re-run listener setup now that getElementById resolves the buttons.
		NavigationButtons.setupEventListeners();
		doc.getElementById('tfl-nav-back').click();

		assert.ok(
			ipc.sent.some((entry) => entry.channel === 'navigate-back'),
			`Expected a navigate-back send, got ${JSON.stringify(ipc.sent)}`
		);
	});

	it('sends navigate-forward over IPC', () => {
		const { ipc, doc } = setup();
		NavigationButtons.setupEventListeners();
		doc.getElementById('tfl-nav-forward').click();

		assert.ok(ipc.sent.some((entry) => entry.channel === 'navigate-forward'));
	});

	it('requests navigation state with the get-navigation-state channel', () => {
		const { ipc } = setup();
		NavigationButtons.updateButtonStates();

		assert.ok(ipc.invoked.some((entry) => entry.channel === 'get-navigation-state'));
	});

	it('subscribes to navigation-state-changed', () => {
		const { ipc } = setup();
		NavigationButtons.setupEventListeners();

		assert.ok(ipc.listeners.has('navigation-state-changed'));
	});

	it('applies pushed navigation state to the buttons', () => {
		const { ipc, doc } = setup();
		NavigationButtons.setupEventListeners();

		ipc.listeners.get('navigation-state-changed')(null, false, true);

		assert.strictEqual(doc.getElementById('tfl-nav-back').disabled, true);
		assert.strictEqual(doc.getElementById('tfl-nav-forward').disabled, false);
	});

	it('does not throw when no ipcRenderer was supplied', () => {
		const doc = createDocumentStub();
		globalThis.document = doc;
		NavigationButtons = loadModule();

		assert.doesNotThrow(() => {
			NavigationButtons.init({}, undefined);
			NavigationButtons.setupEventListeners();
		});
	});
});
