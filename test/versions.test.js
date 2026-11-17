// Version 2 (the default for new nodes) sends one text per item and has no several-recipients operation. Version 1
// keeps it for saved workflows, now as one POST /api/v1/sms/send per number with the output it always had.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NodeApiError, NodeOperationError, Workflow } = require('n8n-workflow');
const { SmsTunnel } = require('../dist/nodes/SmsTunnel/SmsTunnel.node.js');
const { retryAfterMs } = require('../dist/nodes/SmsTunnel/GenericFunctions.js');
const { nodeOf, run } = require('./harness');

const N1 = '+14155550101';
const N2 = '+14155550102';
const N3 = '+14155550103';
const REMAINING = (left) => ({ clean: left, total: 'unlimited' });

/** What SMSTunnel answers a POST /api/v1/sms/send (public-api.controller.ts sendSms). */
const sent = (messageId, { branded = false, left = 46, queued } = {}) => [
	200,
	{ success: true, messageId, ...(queued ? { queued } : {}), data: { messageId, branded, ...(queued ? { queued } : {}), remaining: REMAINING(left) } },
];
const refusedNumber = (to) => [400, { statusCode: 400, error: 'Bad Request', message: `Invalid phone number: ${to}` }];
const dailyLimit = [429, { statusCode: 429, message: 'You have sent as many texts as the Free plan allows today.' }];
const perMinute = [429, { statusCode: 429, message: 'ThrottlerException: Too Many Requests' }, { 'retry-after': '0' }];

const several = (toBulk, extra = {}) => ({
	resource: 'message',
	operation: 'sendBulk',
	toBulk,
	message: 'The office is closed today.',
	additionalFields: extra,
});

describe('the node description', () => {
	const { description } = new SmsTunnel();
	const operationsOf = (version) =>
		description.properties.filter(
			(p) =>
				p.name === 'operation' &&
				p.displayOptions.show.resource[0] === 'message' &&
				JSON.stringify(p.displayOptions.show['@version']) === JSON.stringify(version === 1 ? [1] : [{ _cnd: { gte: 2 } }]),
		);

	it('has versions 1 and 2, and new nodes get version 2', () => {
		assert.deepEqual(description.version, [1, 2]);
		assert.equal(description.defaultVersion, 2);
	});

	it('offers Send to Several Recipients in version 1 only', () => {
		const [v1] = operationsOf(1);
		const [v2] = operationsOf(2);
		assert.deepEqual(v1.options.map((o) => o.value), ['getReceived', 'getStatus', 'send', 'send2fa', 'sendBulk']);
		assert.deepEqual(v2.options.map((o) => o.value), ['getReceived', 'getStatus', 'send', 'send2fa']);
		assert.equal(v1.default, 'send');
		assert.equal(v2.default, 'send');
		const toBulk = description.properties.find((p) => p.name === 'toBulk');
		assert.deepEqual(toBulk.displayOptions.show['@version'], [1]);
	});

	it('shows the operation by its name on the canvas, never its stored value', () => {
		const nodeTypes = {
			getByName: () => ({ description }),
			getByNameAndVersion: () => ({ description }),
			getKnownTypes: () => ({}),
		};
		for (const [typeVersion, resource, operation, shown] of [
			[1, 'message', 'sendBulk', 'Send to Several Recipients: Message'],
			[2, 'message', 'send', 'Send: Message'],
			[2, 'message', 'send2fa', 'Send 2FA Code: Message'],
			[2, 'scheduledText', 'getAll', 'Get Many: Scheduled Text'],
			[2, 'device', 'getAll', 'Get Many: Device'],
			[2, 'account', 'getUsage', 'Get Usage: Account'],
		]) {
			const node = { ...nodeOf(typeVersion), parameters: { resource, operation } };
			const workflow = new Workflow({ id: 'w', name: 'w', nodes: [node], connections: {}, active: false, nodeTypes, staticData: {}, settings: {} });
			assert.equal(workflow.expression.getSimpleParameterValue(node, description.subtitle, 'internal', {}), shown);
		}
	});

	it('words its texts without the words the wording rules forbid', () => {
		const banned = /\b(gateway|bulk|campaign|marketing|mass)\b/i;
		const texts = [];
		const walk = (value, key) => {
			if (typeof value === 'string') {
				// Stored names and values (sendBulk, toBulk) are not shown to people.
				if (!['value', 'name', 'default'].includes(key)) texts.push(value);
			} else if (Array.isArray(value)) value.forEach((v) => walk(v, key));
			else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, k));
		};
		walk(description, '');
		for (const text of texts) assert.doesNotMatch(text, banned, text);
		// Option names are shown.
		const optionNames = description.properties.flatMap((p) => (p.options ?? []).map((o) => o.name ?? o.displayName));
		for (const name of optionNames) assert.doesNotMatch(String(name), banned, name);
	});
});

describe('version 1: Send to Several Recipients', () => {
	it('sends one POST /api/v1/sms/send per number, with the output the single request had', async () => {
		const answers = { [N1]: sent('6735a0c4e1d9e1b7b54cf001', { left: 47 }), [N2]: sent('6735a0c4e1d9e1b7b54cf002', { left: 46 }), [N3]: sent('6735a0c4e1d9e1b7b54cf003', { left: 45 }) };
		const { output, calls, paired } = await run(several(` ${N1}, ${N2};\n${N3} `, { deviceId: 'd1', defaultCountryCode: '+1' }), (options) => answers[options.body.to]);
		assert.equal(calls.length, 3);
		assert.deepEqual(
			calls.map((c) => [c.method, c.url, c.body]),
			[N1, N2, N3].map((to) => [
				'POST',
				'https://smstunnel.test/api/v1/sms/send',
				{ to, message: 'The office is closed today.', deviceId: 'd1', defaultCountryCode: '+1' },
			]),
		);
		assert.ok(calls.every((c) => !c.url.includes('send-bulk')));
		assert.deepEqual(output, [
			{
				success: true,
				data: {
					messageIds: ['6735a0c4e1d9e1b7b54cf001', '6735a0c4e1d9e1b7b54cf002', '6735a0c4e1d9e1b7b54cf003'],
					branded: false,
					count: 3,
					remaining: REMAINING(45),
				},
			},
		]);
		assert.deepEqual(paired, [{ item: 0 }]);
	});

	it('says branded when any text got the Free plan line, as the single request did', async () => {
		const answers = { [N1]: sent('a1'), [N2]: sent('a2', { branded: true }) };
		const { output } = await run(several(`${N1},${N2}`), (options) => answers[options.body.to]);
		assert.equal(output[0].data.branded, true);
		assert.equal(output[0].data.count, 2);
	});

	it('lists a number SMSTunnel refuses in refused, with why, and sends the others', async () => {
		const answers = { [N1]: sent('a1'), [N2]: refusedNumber(N2), [N3]: sent('a3') };
		const { output, calls } = await run(several(`${N1},${N2},${N3}`), (options) => answers[options.body.to]);
		assert.equal(calls.length, 3);
		assert.deepEqual(output[0].data, {
			messageIds: ['a1', 'a3'],
			branded: false,
			count: 2,
			remaining: REMAINING(46),
			refused: [N2],
			error: `Invalid phone number: ${N2}`,
		});
	});

	it("at the plan's daily limit, stops: the rest is refused, as the single request did", async () => {
		const answers = { [N1]: sent('a1', { left: 0 }), [N2]: dailyLimit, [N3]: sent('a3') };
		const { output, calls } = await run(several(`${N1},${N2},${N3}`), (options) => answers[options.body.to]);
		assert.equal(calls.length, 2);
		assert.deepEqual(output[0].data, {
			messageIds: ['a1'],
			branded: false,
			count: 1,
			remaining: REMAINING(0),
			refused: [N2, N3],
			error: 'You have sent as many texts as the Free plan allows today.',
		});
	});

	it('when no text goes out, fails the item with the first refusal, as the single request did', async () => {
		await assert.rejects(run(several(`${N1},${N2}`), (options) => refusedNumber(options.body.to)), (error) => {
			assert.ok(error instanceof NodeApiError);
			assert.equal(error.httpCode, '400');
			assert.equal(error.message, 'Bad request - please check your parameters');
			assert.equal(error.description, `Invalid phone number: ${N1}`);
			return true;
		});
		const { output } = await run(several(`${N1},${N2}`), () => dailyLimit, { continueOnFail: true });
		assert.deepEqual(output, [
			{ error: 'The service is receiving too many requests from you', httpCode: '429', description: 'You have sent as many texts as the Free plan allows today.' },
		]);
		const key = await run(several(`${N1},${N2}`), () => [401, { statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired API key' }], {
			continueOnFail: true,
		});
		assert.equal(key.calls.length, 1, 'a refused key stops the list');
		assert.equal(key.output[0].httpCode, '401');
	});

	it("waits when the per-minute limit says so (Retry-After), then sends that number's text", async () => {
		let throttled = 0;
		const { output, calls } = await run(several(`${N1},${N2}`), (options) => {
			if (options.body.to === N2 && throttled < 2) {
				throttled++;
				return perMinute;
			}
			return sent(options.body.to === N1 ? 'a1' : 'a2');
		});
		assert.equal(calls.length, 4);
		assert.deepEqual(output[0].data.messageIds, ['a1', 'a2']);
		assert.equal(output[0].data.refused, undefined);
	});

	it('stops waiting after three Retry-Afters for one number: it and the rest are refused', async () => {
		const { output, calls } = await run(several(`${N1},${N2},${N3}`), (options) => (options.body.to === N1 ? sent('a1') : perMinute));
		assert.equal(calls.length, 1 + 4);
		assert.deepEqual(output[0].data.refused, [N2, N3]);
		assert.equal(output[0].data.error, 'ThrottlerException: Too Many Requests. The node asked 4 times for this request: try again after 0 s.');
	});

	it('still checks the list before anything is sent', async () => {
		const empty = await run(several(' ,; '), undefined, { continueOnFail: true });
		assert.deepEqual(empty.output, [{ error: 'No recipient phone number was provided' }]);
		const numbers = Array.from({ length: 101 }, (_, n) => `+1415555${String(n).padStart(4, '0')}`).join(',');
		const many = await run(several(numbers), undefined, { continueOnFail: true });
		assert.match(many.output[0].error, /^Too many recipients \(101\): at most 100 per item/);
		assert.equal(empty.calls.length + many.calls.length, 0);
	});
});

describe('version 2', () => {
	const sendTo = (to) => ({ resource: 'message', operation: 'send', to, message: 'The office is closed today.', additionalFields: {} });

	it('sends one text per item, and gives back what SMSTunnel answered', async () => {
		const numbers = [N1, N2, N3];
		const { output, calls, paired } = await run((i) => sendTo(numbers[i]), (options) => sent(`m-${options.body.to}`), { version: 2, items: 3 });
		assert.deepEqual(calls.map((c) => c.body.to), numbers);
		assert.ok(calls.every((c) => c.url === 'https://smstunnel.test/api/v1/sms/send'));
		assert.deepEqual(output, numbers.map((to) => sent(`m-${to}`)[1]));
		assert.deepEqual(paired, [{ item: 0 }, { item: 1 }, { item: 2 }]);
	});

	it('has no Send to Several Recipients: a version 2 node set to it stops before anything is sent', async () => {
		const { output, calls } = await run(several(`${N1},${N2}`), undefined, { version: 2, continueOnFail: true });
		assert.equal(calls.length, 0);
		assert.equal(output[0].error, 'Send to Several Recipients is not in version 2 of the SMSTunnel node');
		assert.match(output[0].description, /put each number in its own item \(for example with Split Out\) and use Send/);
	});

	it('waits when the per-minute limit says so, then sends the same text once', async () => {
		let throttled = false;
		const { output, calls } = await run(sendTo(N1), () => {
			if (!throttled) {
				throttled = true;
				return perMinute;
			}
			return sent('a1');
		}, { version: 2 });
		assert.equal(calls.length, 2);
		assert.deepEqual(calls[0].body, calls[1].body);
		assert.deepEqual(output, [sent('a1')[1]]);
	});

	it("does not wait for the plan's daily limit (no Retry-After), and reports errors as version 1 does", async () => {
		const answers = {
			[N1]: dailyLimit,
			[N2]: [400, { statusCode: 400, error: 'Bad Request', code: 'SCHEDULE_TOO_SOON', message: 'Pick a time at least a minute from now.' }],
		};
		const numbers = [N1, N2];
		for (const version of [1, 2]) {
			const { output, calls } = await run((i) => sendTo(numbers[i]), (options) => answers[options.body.to], { version, items: 2, continueOnFail: true });
			assert.equal(calls.length, 2, `v${version}`);
			assert.deepEqual(output, [
				{ error: 'The service is receiving too many requests from you', httpCode: '429', description: 'You have sent as many texts as the Free plan allows today.' },
				{ error: 'Bad request - please check your parameters', code: 'SCHEDULE_TOO_SOON', httpCode: '400', description: 'Pick a time at least a minute from now.' },
			], `v${version}`);
		}
	});

	it('without Continue On Fail, stops the workflow with the NodeApiError, as version 1 does', async () => {
		for (const version of [1, 2]) {
			await assert.rejects(run(sendTo(N1), () => refusedNumber(N1), { version }), (error) => {
				assert.ok(error instanceof NodeApiError, `v${version}`);
				assert.equal(error.httpCode, '400');
				assert.equal(error.description, `Invalid phone number: ${N1}`);
				return true;
			});
		}
		await assert.rejects(run({ ...sendTo(N1), to: N1, additionalFields: { sendAt: 'soon' } }, undefined, { version: 2 }), NodeOperationError);
	});

	it('version 1 Send answers a per-minute limit as it always did: no wait', async () => {
		const { output, calls } = await run(sendTo(N1), () => perMinute, { version: 1, continueOnFail: true });
		assert.equal(calls.length, 1);
		assert.equal(output[0].httpCode, '429');
	});
});

describe('Retry-After', () => {
	it('is read in seconds or as an HTTP date (the wait budget of the run decides whether to wait)', () => {
		const now = Date.parse('2026-11-17T12:00:00Z');
		assert.equal(retryAfterMs({ 'retry-after': '0' }, now), 0);
		assert.equal(retryAfterMs({ 'retry-after': '12' }, now), 12000);
		assert.equal(retryAfterMs({ 'Retry-After': 7 }, now), 7000);
		assert.equal(retryAfterMs({ 'retry-after': ['3'] }, now), 3000);
		assert.equal(retryAfterMs({ 'retry-after': '600' }, now), 600000);
		assert.equal(retryAfterMs({ 'retry-after': 'Tue, 17 Nov 2026 12:00:30 GMT' }, now), 30000);
		assert.equal(retryAfterMs({ 'retry-after': 'Tue, 17 Nov 2026 11:59:00 GMT' }, now), 0);
		for (const headers of [{}, { 'retry-after': 'soon' }, { 'retry-after': '' }, undefined, null, 'x']) {
			assert.equal(retryAfterMs(headers, now), undefined, JSON.stringify(headers));
		}
	});
});
