'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
	readBridgeDescriptor,
	sendRequest,
	getAssertion,
	createCredential,
	ArcaUnavailableError,
	ArcaRequestError,
	ARCA_ERRORS,
	MUST_SURFACE,
} = require('../../app/passkey/arcaClient');

const TOKEN = 'test-token';

/**
 * A stand-in for Arca's bridge: newline-delimited JSON over loopback TCP.
 * `handler` receives each parsed request line and returns the reply object, or
 * null to send nothing.
 */
function startFakeBridge(handler) {
	return new Promise((resolve) => {
		const received = [];
		const server = net.createServer((socket) => {
			let buffer = '';
			socket.setEncoding('utf8');
			socket.on('data', (chunk) => {
				buffer += chunk;
				let i;
				while ((i = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, i);
					buffer = buffer.slice(i + 1);
					if (!line.trim()) continue;
					const message = JSON.parse(line);
					received.push(message);
					const reply = handler(message, socket);
					if (reply === null || reply === undefined) continue;
					if (typeof reply === 'string') socket.write(reply);
					else socket.write(`${JSON.stringify(reply)}\n`);
				}
			});
			socket.on('error', () => {});
		});
		server.listen(0, '127.0.0.1', () => {
			resolve({
				port: server.address().port,
				received,
				close: () => new Promise((r) => server.close(r)),
			});
		});
	});
}

/** Default handler: accept the token, then answer with a valid assertion. */
function assertionBridge(overrides = {}) {
	return (message) => {
		if (message.type === 'hello') {
			return message.token === TOKEN ? { type: 'ok' } : { type: 'error', message: 'denied' };
		}
		return {
			type: 'passkey_assertion',
			credential_id: [1, 2, 3],
			authenticator_data: [4, 5, 6],
			signature: [7, 8, 9],
			user_handle: [10],
			...overrides,
		};
	};
}

describe('Arca client - discovery file', () => {
	function withFile(contents) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-'));
		const file = path.join(dir, 'native-bridge.json');
		if (contents !== null) fs.writeFileSync(file, contents);
		return file;
	}

	it('reads a valid descriptor', async () => {
		const file = withFile(JSON.stringify({ port: 1234, token: 'abc' }));
		assert.deepStrictEqual(await readBridgeDescriptor(file), { port: 1234, token: 'abc' });
	});

	it('reports a missing file as not-running rather than an error', async () => {
		const file = withFile(null);
		await assert.rejects(() => readBridgeDescriptor(file), (error) => {
			assert.ok(error instanceof ArcaUnavailableError);
			assert.strictEqual(error.reason, 'not-running');
			return true;
		});
	});

	it('rejects malformed JSON', async () => {
		const file = withFile('{not json');
		await assert.rejects(() => readBridgeDescriptor(file), /not JSON/);
	});

	it('rejects an out-of-range or non-integer port', async () => {
		for (const port of [0, 65536, -1, 'x', 1.5, null]) {
			const file = withFile(JSON.stringify({ port, token: 'abc' }));
			await assert.rejects(() => readBridgeDescriptor(file), /port is invalid/);
		}
	});

	it('rejects a missing or empty token', async () => {
		for (const token of ['', null, 42, undefined]) {
			const file = withFile(JSON.stringify({ port: 1234, token }));
			await assert.rejects(() => readBridgeDescriptor(file), /token is invalid/);
		}
	});
});

describe('Arca client - transport', () => {
	it('authenticates before sending the request', async () => {
		const bridge = await startFakeBridge(assertionBridge());
		try {
			await sendRequest({
				port: bridge.port,
				token: TOKEN,
				request: { type: 'passkey_get', rp_id: 'example.test' },
			});
			assert.strictEqual(bridge.received[0].type, 'hello');
			assert.strictEqual(bridge.received[0].token, TOKEN);
			assert.strictEqual(bridge.received[1].type, 'passkey_get');
		} finally {
			await bridge.close();
		}
	});

	it('never sends the request when the token is rejected', async () => {
		const bridge = await startFakeBridge(assertionBridge());
		try {
			await assert.rejects(
				() =>
					sendRequest({
						port: bridge.port,
						token: 'wrong',
						request: { type: 'passkey_get' },
					}),
				/rejected the token|arca: denied/
			);
			assert.ok(
				!bridge.received.some((m) => m.type === 'passkey_get'),
				'a rejected token must not be followed by the request'
			);
		} finally {
			await bridge.close();
		}
	});

	it('handles a reply split across packets', async () => {
		const bridge = await startFakeBridge((message, socket) => {
			if (message.type === 'hello') return { type: 'ok' };
			const json = JSON.stringify({
				type: 'passkey_assertion',
				credential_id: [1],
				authenticator_data: [2],
				signature: [3],
			});
			socket.write(json.slice(0, 10));
			setTimeout(() => socket.write(`${json.slice(10)}\n`), 10);
			return null;
		});
		try {
			const reply = await sendRequest({
				port: bridge.port,
				token: TOKEN,
				request: { type: 'passkey_get' },
			});
			assert.strictEqual(reply.type, 'passkey_assertion');
		} finally {
			await bridge.close();
		}
	});

	it('reports an unreachable port as unavailable', async () => {
		// Port 1 on loopback is not listening.
		await assert.rejects(
			() => sendRequest({ port: 1, token: TOKEN, request: {}, timeoutMs: 2000 }),
			(error) => {
				assert.ok(error instanceof ArcaUnavailableError);
				return true;
			}
		);
	});

	it('rejects malformed JSON from the bridge', async () => {
		const bridge = await startFakeBridge((message, socket) => {
			if (message.type === 'hello') return { type: 'ok' };
			socket.write('{not json\n');
			return null;
		});
		try {
			await assert.rejects(
				() => sendRequest({ port: bridge.port, token: TOKEN, request: {} }),
				/malformed JSON/
			);
		} finally {
			await bridge.close();
		}
	});

	it('times out rather than hanging when no reply arrives', async () => {
		const bridge = await startFakeBridge((message) =>
			message.type === 'hello' ? { type: 'ok' } : null
		);
		try {
			await assert.rejects(
				() =>
					sendRequest({
						port: bridge.port,
						token: TOKEN,
						request: {},
						timeoutMs: 300,
					}),
				/timed out/
			);
		} finally {
			await bridge.close();
		}
	});
});

describe('Arca client - error mapping', () => {
	it('maps every documented reason to an ArcaRequestError', async () => {
		for (const reason of ARCA_ERRORS) {
			const bridge = await startFakeBridge((message) =>
				message.type === 'hello' ? { type: 'ok' } : { type: 'error', message: reason }
			);
			try {
				await assert.rejects(
					() => sendRequest({ port: bridge.port, token: TOKEN, request: {} }),
					(error) => {
						assert.ok(error instanceof ArcaRequestError, `${reason} should be a request error`);
						assert.strictEqual(error.reason, reason);
						return true;
					}
				);
			} finally {
				await bridge.close();
			}
		}
	});

	it('marks only "excluded" as needing to surface to the page', async () => {
		for (const reason of ARCA_ERRORS) {
			const bridge = await startFakeBridge((message) =>
				message.type === 'hello' ? { type: 'ok' } : { type: 'error', message: reason }
			);
			try {
				await sendRequest({ port: bridge.port, token: TOKEN, request: {} }).catch((error) => {
					assert.strictEqual(
						error.surfaceToPage,
						reason === MUST_SURFACE,
						`${reason}: surfaceToPage should be ${reason === MUST_SURFACE}`
					);
				});
			} finally {
				await bridge.close();
			}
		}
	});

	it('treats an unknown error reason as internal rather than trusting it', async () => {
		const bridge = await startFakeBridge((message) =>
			message.type === 'hello' ? { type: 'ok' } : { type: 'error', message: 'something-new' }
		);
		try {
			await assert.rejects(
				() => sendRequest({ port: bridge.port, token: TOKEN, request: {} }),
				(error) => {
					assert.strictEqual(error.reason, 'internal');
					assert.strictEqual(error.surfaceToPage, false);
					return true;
				}
			);
		} finally {
			await bridge.close();
		}
	});
});

describe('Arca client - request shape', () => {
	it('sends passkey_get with snake_case fields and returns camelCase', async () => {
		const bridge = await startFakeBridge(assertionBridge());
		try {
			const result = await getAssertion(
				{
					origin: 'https://login.microsoft.com',
					rpId: 'login.microsoft.com',
					clientDataHash: [1, 2, 3],
					allowCredentials: [[9, 9]],
				},
				{ readDescriptor: async () => ({ port: bridge.port, token: TOKEN }) }
			);

			const sent = bridge.received.find((m) => m.type === 'passkey_get');
			assert.strictEqual(sent.origin, 'https://login.microsoft.com');
			assert.strictEqual(sent.rp_id, 'login.microsoft.com');
			assert.deepStrictEqual(sent.client_data_hash, [1, 2, 3]);
			assert.deepStrictEqual(sent.allow_credentials, [[9, 9]]);

			assert.deepStrictEqual(result.credentialId, [1, 2, 3]);
			assert.deepStrictEqual(result.authenticatorData, [4, 5, 6]);
			assert.deepStrictEqual(result.signature, [7, 8, 9]);
			assert.deepStrictEqual(result.userHandle, [10]);
		} finally {
			await bridge.close();
		}
	});

	it('normalises a missing user_handle to null', async () => {
		const bridge = await startFakeBridge((message) =>
			message.type === 'hello'
				? { type: 'ok' }
				: {
						type: 'passkey_assertion',
						credential_id: [1],
						authenticator_data: [2],
						signature: [3],
					}
		);
		try {
			const result = await getAssertion(
				{ origin: 'https://x.test', rpId: 'x.test', clientDataHash: [] },
				{ readDescriptor: async () => ({ port: bridge.port, token: TOKEN }) }
			);
			assert.strictEqual(result.userHandle, null);
		} finally {
			await bridge.close();
		}
	});

	it('rejects a reply of the wrong type', async () => {
		const bridge = await startFakeBridge((message) =>
			message.type === 'hello' ? { type: 'ok' } : { type: 'passkey_credential' }
		);
		try {
			await assert.rejects(
				() =>
					getAssertion(
						{ origin: 'https://x.test', rpId: 'x.test', clientDataHash: [] },
						{ readDescriptor: async () => ({ port: bridge.port, token: TOKEN }) }
					),
				/unexpected reply/
			);
		} finally {
			await bridge.close();
		}
	});

	it('sends passkey_create and returns the credential', async () => {
		const bridge = await startFakeBridge((message) =>
			message.type === 'hello'
				? { type: 'ok' }
				: {
						type: 'passkey_credential',
						credential_id: [1, 1],
						attestation_object: [2, 2],
					}
		);
		try {
			const result = await createCredential(
				{
					origin: 'https://x.test',
					rpId: 'x.test',
					userName: 'frank',
					userHandle: [5],
					excludeCredentials: [[7]],
				},
				{ readDescriptor: async () => ({ port: bridge.port, token: TOKEN }) }
			);

			const sent = bridge.received.find((m) => m.type === 'passkey_create');
			assert.strictEqual(sent.user_name, 'frank');
			assert.deepStrictEqual(sent.user_handle, [5]);
			assert.deepStrictEqual(sent.exclude_credentials, [[7]]);
			assert.deepStrictEqual(result.credentialId, [1, 1]);
			assert.deepStrictEqual(result.attestationObject, [2, 2]);
		} finally {
			await bridge.close();
		}
	});
});
