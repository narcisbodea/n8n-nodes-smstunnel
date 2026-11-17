// Where the API key may go (the credentials' Base URL) and what may go into a URL path (SMSTunnel's own ids only).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NodeOperationError } = require('n8n-workflow');
const { SmsTunnelApi } = require('../dist/credentials/SmsTunnelApi.credentials.js');
const { KEY, ID, run } = require('./harness');

const usage = { resource: 'account', operation: 'getUsage' };
const USAGE = () => [200, { success: true, data: { plan: 'free' } }];

describe('the Base URL of the credentials', () => {
	it('is used as origin and path, without trailing slashes, and gets the key', async () => {
		for (const [baseUrl, url] of [
			['https://smstunnel.io', 'https://smstunnel.io/api/v1/account/usage'],
			['https://smstunnel.io/', 'https://smstunnel.io/api/v1/account/usage'],
			['  HTTPS://SMSTunnel.IO:443//  ', 'https://smstunnel.io/api/v1/account/usage'],
			['https://sms.example.test/smstunnel/', 'https://sms.example.test/smstunnel/api/v1/account/usage'],
			['http://localhost:3172', 'http://localhost:3172/api/v1/account/usage'],
			['http://127.0.0.1:3172/', 'http://127.0.0.1:3172/api/v1/account/usage'],
			// Left empty: SMSTunnel's own server.
			['', 'https://smstunnel.io/api/v1/account/usage'],
			[undefined, 'https://smstunnel.io/api/v1/account/usage'],
		]) {
			const { calls } = await run(usage, USAGE, { credentials: { apiKey: KEY, baseUrl } });
			assert.equal(calls.length, 1, String(baseUrl));
			assert.equal(calls[0].url, url, String(baseUrl));
			assert.equal(calls[0].headers['X-API-Key'], KEY, String(baseUrl));
		}
	});

	it('is refused before anything is sent when it is not https:// (http:// only on this computer)', async () => {
		for (const baseUrl of [
			'http://smstunnel.io',
			'http://192.168.1.10:3000',
			'http://localhost.example.test',
			'ftp://smstunnel.io',
			'ws://smstunnel.io',
			'javascript:alert(1)',
			'file:///etc/passwd',
		]) {
			await assert.rejects(run(usage, USAGE, { baseUrl, continueOnFail: true }), (error) => {
				assert.ok(error instanceof NodeOperationError, baseUrl);
				assert.equal(error.message, 'The Base URL in the SMSTunnel credentials must start with https://', baseUrl);
				assert.match(error.description, /The API key is sent to this address/);
				return true;
			});
		}
	});

	it('is refused when it is not a web address, or has a user name, password, query or fragment', async () => {
		for (const [baseUrl, message] of [
			['smstunnel.io', /is not a web address/],
			['https://', /is not a web address/],
			['https://user:hunter2@smstunnel.io', /must not contain a user name or password/],
			['https://:hunter2@smstunnel.io', /must not contain a user name or password/],
			['https://hunter2@smstunnel.io', /must not contain a user name or password/],
			['https://smstunnel.io/?key=hunter2', /must not have a query/],
			['https://smstunnel.io?', /must not have a query/],
			['https://smstunnel.io/#hunter2', /must not have a query \(\?…\) or a fragment/],
			['https://smstunnel.io#', /must not have a query \(\?…\) or a fragment/],
		]) {
			await assert.rejects(run(usage, USAGE, { baseUrl }), (error) => {
				assert.ok(error instanceof NodeOperationError, baseUrl);
				assert.match(error.message, message, baseUrl);
				// The address may hold a password: it is never repeated.
				assert.ok(!`${error.message} ${error.description}`.includes('hunter2'), baseUrl);
				return true;
			});
		}
	});
});

describe('ids in URL paths', () => {
	const BAD_IDS = [
		'',
		'm1',
		'..',
		'../account/usage',
		`${ID}/..`,
		`../${ID}`,
		'%2e%2e',
		ID.slice(1), // 23 characters
		`${ID}a`, // 25
		`${ID.slice(1)}g`, // not hexadecimal
		`${ID.slice(0, 12)} ${ID.slice(12)}`,
	];

	it('Get Status takes a messageId of 24 hexadecimal characters (spaces around it trimmed)', async () => {
		for (const messageId of [ID, ` ${ID} `, ID.toUpperCase()]) {
			const { calls } = await run({ resource: 'message', operation: 'getStatus', messageId }, () => [200, { success: true }]);
			assert.equal(calls[0].url, `https://smstunnel.test/api/v1/sms/status/${messageId.trim()}`);
		}
	});

	it('Get Status refuses any other Message ID before anything is asked', async () => {
		for (const messageId of BAD_IDS) {
			const { output, calls } = await run({ resource: 'message', operation: 'getStatus', messageId }, undefined, {
				continueOnFail: true,
			});
			assert.equal(calls.length, 0, messageId);
			assert.equal(output[0].error, 'The Message ID is not an ID from SMSTunnel', messageId);
			assert.match(output[0].description, /24 characters, digits and the letters a to f/);
		}
		await assert.rejects(run({ resource: 'message', operation: 'getStatus', messageId: '../devices' }), NodeOperationError);
	});

	it('Scheduled Text Get and Cancel refuse any other Scheduled Text ID before anything is asked', async () => {
		for (const operation of ['get', 'cancel']) {
			for (const scheduledId of BAD_IDS.filter(Boolean)) {
				const { output, calls } = await run({ resource: 'scheduledText', operation, scheduledId }, undefined, {
					continueOnFail: true,
				});
				assert.equal(calls.length, 0, `${operation} ${scheduledId}`);
				assert.equal(output[0].error, 'The Scheduled Text ID is not an ID from SMSTunnel', `${operation} ${scheduledId}`);
			}
			const fine = await run({ resource: 'scheduledText', operation, scheduledId: ID.toUpperCase() }, () => [200, { success: true }]);
			assert.equal(fine.calls[0].url, `https://smstunnel.test/api/v1/sms/scheduled/${ID.toUpperCase()}`);
		}
	});
});

describe("the credentials' authenticate()", () => {
	const authenticate = (baseUrl, options) => new SmsTunnelApi().authenticate({ apiKey: KEY, baseUrl }, options);

	it('adds the key as X-API-Key to a request for the Base URL, keeping the other headers', async () => {
		const sent = await authenticate('https://smstunnel.io', {
			url: 'https://smstunnel.io/api/v1/sms/send',
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
		});
		assert.deepEqual(sent.headers, { 'Content-Type': 'application/json', 'X-API-Key': KEY });
		assert.equal(sent.url, 'https://smstunnel.io/api/v1/sms/send');
		// A redirect would take the key along.
		assert.equal(sent.disableFollowRedirect, true);
	});

	it("also for the credentials' Test, which gives baseURL and url apart", async () => {
		const { request } = new SmsTunnelApi().test;
		assert.equal(request.url, '/api/v1/account/usage');
		const sent = await authenticate('https://sms.example.test/smstunnel/', {
			baseURL: 'https://sms.example.test/smstunnel',
			url: request.url,
			method: 'GET',
		});
		assert.equal(sent.headers['X-API-Key'], KEY);
	});

	it('refuses a request for anywhere else (an HTTP Request node pointed elsewhere, say)', async () => {
		for (const [baseUrl, options] of [
			['https://smstunnel.io', { url: 'https://evil.example.test/api/v1/devices' }],
			['https://smstunnel.io', { url: 'http://smstunnel.io/api/v1/devices' }],
			['https://smstunnel.io', { url: 'https://smstunnel.io.evil.example.test/api' }],
			['https://smstunnel.io', { url: 'https://user@smstunnel.io/api/v1/devices' }],
			['https://smstunnel.io', { baseURL: 'https://smstunnel.io', url: '//evil.example.test/api' }],
			['https://smstunnel.io', { url: '/api/v1/devices' }],
			['https://sms.example.test/smstunnel', { url: 'https://sms.example.test/other/api' }],
			['https://sms.example.test/smstunnel', { url: 'https://sms.example.test/smstunnelx/api' }],
			['https://sms.example.test/smstunnel', { url: 'https://sms.example.test/smstunnel/../other' }],
		]) {
			await assert.rejects(authenticate(baseUrl, options), /The SMSTunnel API key is only sent to the Base URL of its credentials/, JSON.stringify(options));
		}
	});

	it('refuses everything when the Base URL itself is refused', async () => {
		await assert.rejects(
			authenticate('http://smstunnel.io', { url: 'http://smstunnel.io/api/v1/devices' }),
			/The Base URL in the SMSTunnel credentials must start with https:\/\//,
		);
		await assert.rejects(
			authenticate('https://user:hunter2@smstunnel.io', { url: 'https://smstunnel.io/api/v1/devices' }),
			(error) => /must not contain a user name or password/.test(error.message) && !error.message.includes('hunter2'),
		);
	});

	it("keeps the Base URL field's default and says where the key goes", () => {
		const field = new SmsTunnelApi().properties.find((p) => p.name === 'baseUrl');
		assert.equal(field.default, 'https://smstunnel.io');
		assert.match(field.description, /^Your API key is sent to this address\. Keep https:\/\/smstunnel\.io unless you run your own SMSTunnel server/);
	});
});
