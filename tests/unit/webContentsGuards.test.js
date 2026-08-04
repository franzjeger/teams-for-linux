'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
	buildTrustedDomains,
	isTrustedUrl,
	decidePermission,
	decideNavigation,
	hardenWebviewPreferences,
	ALLOWED_PERMISSIONS,
	ORIGIN_SCOPED_PERMISSIONS,
} = require('../../app/security/webContentsGuards');

const TRUSTED = buildTrustedDomains({ url: 'https://teams.microsoft.com/v2' });

describe('WebContents guards - trusted domain matching', () => {
	it('trusts Microsoft endpoints and their subdomains', () => {
		const trustedUrls = [
			'https://teams.microsoft.com/v2/',
			'https://login.microsoftonline.com/common/oauth2/authorize',
			'https://eu-prod.asyncgw.teams.microsoft.com/v1/',
			'https://res.cdn.office.net/assets/x.js',
			'https://contoso.sharepoint.com/sites/team',
			'https://teams.cloud.microsoft/',
		];
		for (const url of trustedUrls) {
			assert.strictEqual(isTrustedUrl(url, TRUSTED), true, `Expected '${url}' to be trusted`);
		}
	});

	it('does not trust lookalike domains', () => {
		const untrustedUrls = [
			'https://notmicrosoft.com/',
			'https://microsoft.com.evil.test/',
			'https://teams.microsoft.com.attacker.test/',
			'https://evil.test/?next=teams.microsoft.com',
			'https://xmicrosoft.com/',
		];
		for (const url of untrustedUrls) {
			assert.strictEqual(isTrustedUrl(url, TRUSTED), false, `Expected '${url}' to be untrusted`);
		}
	});

	it('never trusts non-https schemes', () => {
		const schemes = [
			'http://teams.microsoft.com/',
			'file:///etc/passwd',
			// eslint-disable-next-line no-script-url -- fixture: this is exactly what must be rejected
			'javascript:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'msteams://teams.microsoft.com/l/meetup-join/x',
		];
		for (const url of schemes) {
			assert.strictEqual(isTrustedUrl(url, TRUSTED), false, `Expected '${url}' to be untrusted`);
		}
	});

	it('rejects malformed URLs instead of throwing', () => {
		for (const url of ['', 'not a url', null, undefined, '///']) {
			assert.strictEqual(isTrustedUrl(url, TRUSTED), false);
		}
	});

	it('trusts the configured Teams URL host', () => {
		const domains = buildTrustedDomains({ url: 'https://teams.corp.test/v2' });
		assert.strictEqual(isTrustedUrl('https://teams.corp.test/v2', domains), true);
	});

	it('trusts administrator-declared additional origins', () => {
		const domains = buildTrustedDomains({
			url: 'https://teams.microsoft.com',
			security: { additionalTrustedOrigins: ['https://sso.corp.test', 'idp.corp.test', '*.okta.corp.test'] },
		});

		assert.strictEqual(isTrustedUrl('https://sso.corp.test/saml', domains), true);
		assert.strictEqual(isTrustedUrl('https://idp.corp.test/', domains), true);
		assert.strictEqual(isTrustedUrl('https://tenant.okta.corp.test/', domains), true);
		assert.strictEqual(isTrustedUrl('https://elsewhere.test/', domains), false);
	});

	it('ignores malformed entries in additionalTrustedOrigins', () => {
		const domains = buildTrustedDomains({
			security: { additionalTrustedOrigins: ['', '   ', null, 42, {}] },
		});
		assert.strictEqual(isTrustedUrl('https://evil.test/', domains), false);
	});
});

describe('WebContents guards - permission decisions', () => {
	const teamsUrl = 'https://teams.microsoft.com/v2/';
	const evilUrl = 'https://evil.test/';

	it('grants the permissions Teams needs from a trusted origin', () => {
		for (const permission of ALLOWED_PERMISSIONS) {
			const { granted } = decidePermission(permission, teamsUrl, TRUSTED);
			assert.strictEqual(granted, true, `Expected '${permission}' to be granted`);
		}
	});

	it('denies permissions Teams does not use', () => {
		const unused = [
			'geolocation',
			'hid',
			'serial',
			'usb',
			'midi',
			'midiSysex',
			'idle-detection',
			'window-management',
			'keyboardLock',
			'deprecated-sync-clipboard-read',
			'fileSystem',
		];
		for (const permission of unused) {
			const { granted } = decidePermission(permission, teamsUrl, TRUSTED);
			assert.strictEqual(granted, false, `Expected '${permission}' to be denied`);
		}
	});

	it('denies an unknown permission, so new Electron permissions default to off', () => {
		const { granted, reason } = decidePermission('some-future-permission', teamsUrl, TRUSTED);
		assert.strictEqual(granted, false);
		assert.match(reason, /not required/);
	});

	it('denies camera, microphone and screen capture from an untrusted origin', () => {
		for (const permission of ORIGIN_SCOPED_PERMISSIONS) {
			const { granted, reason } = decidePermission(permission, evilUrl, TRUSTED);
			assert.strictEqual(granted, false, `Expected '${permission}' to be denied off-origin`);
			assert.strictEqual(reason, 'untrusted origin');
		}
	});

	it('still allows non-powerful permissions from any origin', () => {
		for (const permission of ['notifications', 'fullscreen', 'clipboard-read']) {
			const { granted } = decidePermission(permission, evilUrl, TRUSTED);
			assert.strictEqual(granted, true, `Expected '${permission}' to be granted`);
		}
	});

	it('denies malformed permission values', () => {
		for (const permission of ['', null, undefined, 42, {}]) {
			assert.strictEqual(decidePermission(permission, teamsUrl, TRUSTED).granted, false);
		}
	});

	it('denies media when the requesting URL is missing', () => {
		assert.strictEqual(decidePermission('media', '', TRUSTED).granted, false);
		assert.strictEqual(decidePermission('media', undefined, TRUSTED).granted, false);
	});
});

describe('WebContents guards - navigation decisions', () => {
	it('allows any origin while navigation restriction is off', () => {
		const { allowed } = decideNavigation('https://sso.customer.test/saml', TRUSTED, false);
		assert.strictEqual(allowed, true);
	});

	it('reports whether an allowed navigation was trusted or merely unrestricted', () => {
		assert.strictEqual(
			decideNavigation('https://teams.microsoft.com/', TRUSTED, false).reason,
			'trusted'
		);
		assert.match(
			decideNavigation('https://elsewhere.test/', TRUSTED, false).reason,
			/unrestricted/
		);
	});

	it('blocks untrusted origins once restriction is on', () => {
		const { allowed, reason } = decideNavigation('https://evil.test/', TRUSTED, true);
		assert.strictEqual(allowed, false);
		assert.match(reason, /allowlist/);
	});

	it('still allows trusted origins when restriction is on', () => {
		for (const url of ['https://teams.microsoft.com/v2/', 'https://login.microsoftonline.com/']) {
			assert.strictEqual(decideNavigation(url, TRUSTED, true).allowed, true);
		}
	});

	it('allows about: targets, which are part of normal operation', () => {
		assert.strictEqual(decideNavigation('about:blank', TRUSTED, true).allowed, true);
	});

	it('blocks malformed URLs under both settings', () => {
		for (const restrict of [true, false]) {
			assert.strictEqual(decideNavigation('not a url', TRUSTED, restrict).allowed, false);
		}
	});

	it('blocks file: navigation when restriction is on', () => {
		assert.strictEqual(decideNavigation('file:///etc/passwd', TRUSTED, true).allowed, false);
	});
});

describe('WebContents guards - webview hardening', () => {
	it('strips a preload and forces isolation on', () => {
		const webPreferences = {
			preload: '/tmp/evil.js',
			nodeIntegration: true,
			contextIsolation: false,
			sandbox: false,
			webSecurity: false,
			allowRunningInsecureContent: true,
		};
		const params = { preload: '/tmp/evil.js', nodeintegration: 'true' };

		hardenWebviewPreferences(webPreferences, params);

		assert.strictEqual(webPreferences.preload, undefined);
		assert.strictEqual(webPreferences.nodeIntegration, false);
		assert.strictEqual(webPreferences.contextIsolation, true);
		assert.strictEqual(webPreferences.sandbox, true);
		assert.strictEqual(webPreferences.webSecurity, true);
		assert.strictEqual(webPreferences.allowRunningInsecureContent, false);
		assert.strictEqual(params.preload, undefined);
		assert.strictEqual(params.nodeintegration, 'false');
	});

	it('works when no params object is supplied', () => {
		const webPreferences = { preload: '/tmp/evil.js' };
		hardenWebviewPreferences(webPreferences, undefined);
		assert.strictEqual(webPreferences.preload, undefined);
		assert.strictEqual(webPreferences.contextIsolation, true);
	});
});
