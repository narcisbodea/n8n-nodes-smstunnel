// How the node asks: one Idempotency-Key per text, kept for every try of it; a POST asked again only after a 429 with
// Retry-After (SMSTunnel refused it before doing anything); one wait budget for the whole run; only 2xx as an answer;
// no redirects.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NodeApiError, NodeOperationError } = require('n8n-workflow');
const { WAIT_BUDGET_MS } = require('../dist/nodes/SmsTunnel/GenericFunctions.js');
const { ID, nodeOf, run } = require('./harness');

const N1 = '+14155550101';
const N2 = '+14155550102';
const KEY_FORMAT = /^n8n-smstunnel-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sent = (messageId) => [200, { success: true, messageId, data: { messageId, branded: false, remaining: { clean: 46, total: 'unlimited' } } }];
const perMinute = (seconds = '0') => [429, { statusCode: 429, message: 'ThrottlerException: Too Many Requests' }, { 'retry-after': seconds }];
const sendTo = (to, extra = {}) => ({ resource: 'message', operation: 'send', to, message: 'Your table is ready.', additionalFields: extra });
const keyOf = (call) => call.headers?.['Idempotency-Key'];

describe('Idempotency-Key', () => {
	it('goes with every POST that sends a text, one per text, in both versions', async () => {
		for (const version of [1, 2]) {
			for (const params of [
				sendTo(N1),
				sendTo(N1, { sendAt: '2026-11-20T09:00:00Z' }),
				{ resource: 'message', operation: 'send2fa', to: N1, message: 'Your code is 123456', additionalFields: {} },
			]) {
				const { calls } = await run((i) => ({ ...params, to: [N1, N2][i] }), () => sent('m1'), { version, items: 2 });
				assert.equal(calls.length, 2);
				assert.ok(calls.every((c) => c.method === 'POST' && KEY_FORMAT.test(keyOf(c))), `v${version} ${params.operation}`);
				assert.notEqual(keyOf(calls[0]), keyOf(calls[1]), 'one key per text');
			}
		}
		const several = await run({ resource: 'message', operation: 'sendBulk', toBulk: `${N1},${N2}`, message: 'Hi', additionalFields: {} }, () => sent('m1'));
		assert.equal(several.calls.length, 2);
		assert.ok(several.calls.every((c) => KEY_FORMAT.test(keyOf(c))));
		assert.notEqual(keyOf(several.calls[0]), keyOf(several.calls[1]), 'one key per number');
	});

	it('is the same on every try of one text, with the same request', async () => {
		let throttled = 0;
		const { calls } = await run(sendTo(N1), () => (throttled++ < 2 ? perMinute() : sent('m1')), { version: 2 });
		assert.equal(calls.length, 3);
		assert.equal(new Set(calls.map(keyOf)).size, 1);
		assert.ok(calls.every((c) => JSON.stringify(c.body) === JSON.stringify(calls[0].body)));

		const tries = {};
		const several = await run(
			{ resource: 'message', operation: 'sendBulk', toBulk: `${N1},${N2}`, message: 'Hi', additionalFields: {} },
			(options) => ((tries[options.body.to] = (tries[options.body.to] ?? 0) + 1) === 1 ? perMinute() : sent(`m-${options.body.to}`)),
		);
		assert.equal(several.calls.length, 4);
		const byNumber = (to) => new Set(several.calls.filter((c) => c.body.to === to).map(keyOf));
		assert.equal(byNumber(N1).size, 1);
		assert.equal(byNumber(N2).size, 1);
		assert.notDeepEqual([...byNumber(N1)], [...byNumber(N2)]);
	});

	it('is not sent with the requests that send nothing', async () => {
		for (const params of [
			{ resource: 'message', operation: 'getStatus', messageId: ID },
			{ resource: 'message', operation: 'getReceived' },
			{ resource: 'account', operation: 'getUsage' },
			{ resource: 'device', operation: 'getAll' },
			{ resource: 'scheduledText', operation: 'getAll' },
			{ resource: 'scheduledText', operation: 'get', scheduledId: ID },
			{ resource: 'scheduledText', operation: 'cancel', scheduledId: ID },
		]) {
			for (const version of [1, 2]) {
				const { calls } = await run(params, () => [200, { success: true }], { version });
				assert.equal(keyOf(calls[0]), undefined, `${params.operation} v${version}`);
				assert.notEqual(calls[0].method, 'POST');
			}
		}
	});
});

describe('asking again', () => {
	it('a text is never sent again after a 5xx, a network error, a 409 or a 429 without Retry-After', async () => {
		const answers = [
			[503, { statusCode: 503, message: 'Service Unavailable' }],
			[500, { statusCode: 500, message: 'Internal server error' }],
			[409, { statusCode: 409, code: 'IDEMPOTENCY_KEY_IN_PROGRESS', message: 'A request with this Idempotency-Key is still being processed.' }, { 'retry-after': '1' }],
			[429, { statusCode: 429, message: 'You have sent as many texts as the Free plan allows today.' }],
		];
		for (const version of [1, 2]) {
			for (const operation of ['send', 'send2fa']) {
				for (const answer of answers) {
					const params = { ...sendTo(N1), operation, message: 'Your code is 123456' };
					const { output, calls } = await run(params, () => answer, { version, continueOnFail: true });
					assert.equal(calls.length, 1, `v${version} ${operation} ${answer[0]}`);
					assert.equal(output[0].httpCode, String(answer[0]));
				}
			}
		}
		// A connection that fails: n8n's helper throws (no HTTP answer at all).
		for (const version of [1, 2]) {
			let calls = 0;
			const { output } = await run(sendTo(N1), () => {
				calls++;
				const error = new Error('socket hang up');
				error.code = 'ECONNRESET';
				throw new NodeApiError(nodeOf(version), error);
			}, { version, continueOnFail: true });
			assert.equal(calls, 1, `v${version}`);
			assert.match(output[0].error, /connection/i);
		}
	});
});

describe('the wait budget of one run', () => {
	it('does not wait at all when Retry-After is longer than the budget: the 429 is the answer, with its Retry-After', async () => {
		const started = Date.now();
		const { output, calls } = await run(sendTo(N1), () => perMinute(String(WAIT_BUDGET_MS / 1000 + 1)), { version: 2, continueOnFail: true });
		assert.ok(Date.now() - started < 5000);
		assert.equal(calls.length, 1);
		assert.equal(output[0].httpCode, '429');
		assert.equal(output[0].error, `The service is receiving too many requests from you (Retry-After: ${WAIT_BUDGET_MS / 1000 + 1} s)`);
		assert.equal(
			output[0].description,
			'ThrottlerException: Too Many Requests. The node waits at most 60 s in all in one run (it waited 0 s): try again after 61 s.',
		);
	});

	it('is shared by every item: once spent, the next 429 stops the item', async () => {
		// Every text is refused twice (Retry-After: 0, which counts 1 s against the budget) before it goes out.
		const tries = new Map();
		const items = 35;
		const { output, calls } = await run(
			(i) => sendTo(`+1415555${String(i).padStart(4, '0')}`),
			(options) => {
				const n = (tries.get(options.body.to) ?? 0) + 1;
				tries.set(options.body.to, n);
				return n <= 2 ? perMinute() : sent(`m-${options.body.to}`);
			},
			{ version: 2, items, continueOnFail: true },
		);
		const done = output.filter((o) => o.success === true).length;
		assert.equal(done, WAIT_BUDGET_MS / 1000 / 2, '60 s of waits at 2 s per text');
		assert.ok(output.slice(done).every((o) => o.httpCode === '429' && /Retry-After: 0 s/.test(o.error)));
		// The items after the budget asked once each, and waited no more.
		assert.equal(calls.length, done * 3 + (items - done));
	});

	it("is shared by the numbers of version 1's Send to Several Recipients, and by its later items", async () => {
		const numbers = Array.from({ length: 40 }, (_, n) => `+1415556${String(n).padStart(4, '0')}`);
		const tries = new Map();
		const { output } = await run(
			(i) => ({ resource: 'message', operation: 'sendBulk', toBulk: i === 0 ? numbers.join(',') : N1, message: 'Hi', additionalFields: {} }),
			(options) => {
				const n = (tries.get(options.body.to) ?? 0) + 1;
				tries.set(options.body.to, n);
				return n <= 2 ? perMinute() : sent(`m-${options.body.to}`);
			},
			{ items: 2, continueOnFail: true },
		);
		assert.equal(output[0].data.count, 30);
		assert.deepEqual(output[0].data.refused, numbers.slice(30));
		assert.match(output[0].data.error, /The node waits at most 60 s in all in one run \(it waited 0 s\): try again after 0 s\.$/);
		// The second item gets no waiting left: its only number is refused, so the item fails with the 429.
		assert.equal(output[1].httpCode, '429');
		assert.match(output[1].error, /Retry-After: 0 s/);
	});

	it('really waits for a Retry-After within the budget', async () => {
		let throttled = false;
		const started = Date.now();
		const { output } = await run(sendTo(N1), () => {
			if (throttled) return sent('m1');
			throttled = true;
			return perMinute('1');
		}, { version: 2 });
		assert.ok(Date.now() - started >= 900, 'waited about a second');
		assert.equal(output[0].messageId, 'm1');
	});
});

describe('what counts as an answer', () => {
	it('only 2xx: a 3xx or another unexpected status is an error, in both versions', async () => {
		for (const status of [301, 302, 304, 307, 101]) {
			const v2 = await run(sendTo(N1), () => [status, { success: true, messageId: 'm1' }, { location: 'https://evil.example.test/' }], { version: 2, continueOnFail: true });
			assert.equal(v2.calls.length, 1, String(status));
			assert.equal(v2.output[0].httpCode, String(status));
			assert.equal(v2.output[0].error, `SMSTunnel answered with HTTP ${status}, which the node doesn't take as an answer`);
			assert.match(v2.output[0].description, /Check that the Base URL in the SMSTunnel credentials/);
			const v1 = await run(sendTo(N1), () => [status, { success: true, messageId: 'm1' }], { version: 1, continueOnFail: true });
			assert.equal(v1.output[0].httpCode, String(status));
			assert.equal(v1.output[0].messageId, undefined);
		}
	});

	it('follows no redirect: the key would go along', async () => {
		for (const version of [1, 2]) {
			for (const params of [sendTo(N1), { resource: 'account', operation: 'getUsage' }, { resource: 'scheduledText', operation: 'cancel', scheduledId: ID }]) {
				const { calls } = await run(params, () => [200, { success: true, messageId: 'm1' }], { version });
				assert.equal(calls[0].disableFollowRedirect, true, `${params.operation} v${version}`);
			}
		}
		const several = await run({ resource: 'message', operation: 'sendBulk', toBulk: N1, message: 'Hi', additionalFields: {} }, () => sent('m1'));
		assert.equal(several.calls[0].disableFollowRedirect, true);
	});

	it('in Send to Several Recipients, an answer without a messageId is refused, not counted as sent', async () => {
		const answers = { [N1]: sent('m1'), [N2]: [200, { success: true, data: { branded: false } }] };
		const { output } = await run({ resource: 'message', operation: 'sendBulk', toBulk: `${N1},${N2}`, message: 'Hi', additionalFields: {} }, (options) => answers[options.body.to]);
		assert.deepEqual(output[0].data.messageIds, ['m1']);
		assert.equal(output[0].data.count, 1);
		assert.deepEqual(output[0].data.refused, [N2]);
		assert.match(output[0].data.error, /had no messageId/);

		await assert.rejects(
			run({ resource: 'message', operation: 'sendBulk', toBulk: `${N1},${N2}`, message: 'Hi', additionalFields: {} }, () => [200, { success: true }]),
			(error) => error instanceof NodeOperationError && /No text counted as sent/.test(error.message),
		);
	});
});
