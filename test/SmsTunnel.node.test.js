// The SMSTunnel node against a stand-in for n8n's execute context: every HTTP call is recorded and answered here, and
// an error status is thrown as n8n's own helper throws it (a NodeApiError around the HTTP error). Runs on dist/
// (npm test builds it first), what the package ships.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NodeApiError, NodeOperationError } = require('n8n-workflow');
const { SmsTunnel } = require('../dist/nodes/SmsTunnel/SmsTunnel.node.js');

const KEY = 'sk_' + 'live_' + '0123456789abcdef0123456789abcdef';
const ID = '6735a0c4e1d9e1b7b54cf994';
const NODE = { id: 'n1', name: 'SMSTunnel', type: 'n8n-nodes-smstunnel.smsTunnel', typeVersion: 1, position: [0, 0], parameters: {} };

const scheduledText = (fields = {}) => ({
	id: ID,
	to: '+40712345678',
	message: 'Reminder: your appointment is tomorrow at 10:00.',
	sendAt: '2026-11-16T07:00:00.000Z',
	status: 'scheduled',
	deviceId: null,
	messageId: null,
	error: null,
	createdAt: '2026-11-15T12:00:00.000Z',
	...fields,
});

/** What axios throws for an error status, as n8n's httpRequestWithAuthentication wraps it. */
class AxiosError extends Error {}
function apiError(status, body) {
	const cause = new AxiosError(`Request failed with status code ${status}`);
	cause.isAxiosError = true;
	cause.response = { status, data: body, headers: {} };
	return new NodeApiError(NODE, cause);
}

/** Runs the node once with `params` for every item; `answer(options)` gives [status, body] for each call. */
async function run(params, answer = () => [200, { success: true }], { items = 1, timeZone = 'Europe/Bucharest', continueOnFail = false } = {}) {
	const calls = [];
	const context = {
		getInputData: () => Array.from({ length: items }, () => ({ json: {} })),
		getCredentials: async () => ({ apiKey: KEY, baseUrl: 'https://smstunnel.test/' }),
		getNodeParameter(name, itemIndex, fallback) {
			const value = typeof params === 'function' ? params(itemIndex)[name] : params[name];
			if (value !== undefined) return value;
			if (arguments.length >= 3) return fallback;
			throw new Error(`Could not get parameter "${name}"`);
		},
		getNode: () => NODE,
		getTimezone: () => timeZone,
		continueOnFail: () => continueOnFail,
		helpers: {
			async httpRequestWithAuthentication(credentialsType, options) {
				assert.equal(credentialsType, 'smsTunnelApi');
				calls.push(options);
				const [status, body] = await answer(options);
				if (status >= 400) throw apiError(status, body);
				return body;
			},
		},
	};
	const [output] = await new SmsTunnel().execute.call(context);
	return { output: output.map((item) => item.json), calls };
}

const send = (sendAt, extra = {}) => ({
	resource: 'message',
	operation: 'send',
	to: '+40712345678',
	message: 'Reminder: your appointment is tomorrow at 10:00.',
	additionalFields: sendAt === undefined ? { ...extra } : { ...extra, sendAt },
});
const SCHEDULED = (options) => [
	200,
	{ success: true, scheduled: true, scheduledId: ID, sendAt: options.body.sendAt, data: scheduledText({ sendAt: options.body.sendAt }) },
];

describe('Send with Send At', () => {
	it('schedules the text, with Send At sent as toISOString()', async () => {
		const { output, calls } = await run(send('2026-11-16T09:00:00+02:00', { deviceId: 'd1', defaultCountryCode: '+40' }), SCHEDULED);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].method, 'POST');
		assert.equal(calls[0].url, 'https://smstunnel.test/api/v1/sms/send');
		assert.equal(calls[0].json, true);
		assert.deepEqual(calls[0].body, {
			to: '+40712345678',
			message: 'Reminder: your appointment is tomorrow at 10:00.',
			deviceId: 'd1',
			defaultCountryCode: '+40',
			sendAt: '2026-11-16T07:00:00.000Z',
		});
		assert.deepEqual(output, [
			{ success: true, scheduled: true, scheduledId: ID, sendAt: '2026-11-16T07:00:00.000Z', data: scheduledText() },
		]);
	});

	it("reads the date picker's time, which has no offset, in the workflow's time zone", async () => {
		for (const [timeZone, picked, sent] of [
			['Europe/Bucharest', '2026-11-16T09:00:00', '2026-11-16T07:00:00.000Z'],
			['Europe/Bucharest', '2026-07-16T09:00:00', '2026-07-16T06:00:00.000Z'],
			['America/New_York', '2026-11-16T09:00:00', '2026-11-16T14:00:00.000Z'],
			['Asia/Kolkata', '2026-11-16 09:00', '2026-11-16T03:30:00.000Z'],
			['UTC', '2026-11-16T09:00:00', '2026-11-16T09:00:00.000Z'],
			// The night Bucharest's clocks go back (04:00 becomes 03:00): 02:30 is still summer time, +03:00. Read with
			// the offset of 02:30 UTC it would come out an hour late; the second pass gets it right.
			['Europe/Bucharest', '2026-10-25T02:30:00', '2026-10-24T23:30:00.000Z'],
		]) {
			const { calls } = await run(send(picked), SCHEDULED, { timeZone });
			assert.equal(calls[0].body.sendAt, sent, `${timeZone} ${picked}`);
		}
	});

	it('takes a time with its offset as it is, a Date, and a Luxon DateTime from an expression', async () => {
		for (const [given, sent] of [
			['2026-11-16T09:00:00Z', '2026-11-16T09:00:00.000Z'],
			['2026-11-16T09:00:00.250-05:00', '2026-11-16T14:00:00.250Z'],
			[new Date('2026-11-16T07:00:00.000Z'), '2026-11-16T07:00:00.000Z'],
			[{ toISO: () => '2026-11-16T09:00:00.000+02:00' }, '2026-11-16T07:00:00.000Z'],
		]) {
			const { calls } = await run(send(given), SCHEDULED, { timeZone: 'America/New_York' });
			assert.equal(calls[0].body.sendAt, sent, String(given));
		}
	});

	it('without Send At, sends now, as before', async () => {
		for (const sendAt of [undefined, '', '  ']) {
			const { calls, output } = await run(send(sendAt), () => [200, { success: true, messageId: 'm1', data: { messageId: 'm1' } }]);
			assert.deepEqual(calls[0].body, { to: '+40712345678', message: 'Reminder: your appointment is tomorrow at 10:00.' });
			assert.deepEqual(output, [{ success: true, messageId: 'm1', data: { messageId: 'm1' } }]);
		}
	});

	it('a Send At that is not a real date and time stops the item before anything is sent', async () => {
		for (const sendAt of ['2026-02-30T09:00:00Z', 'tomorrow', '2026-11-16', '2026-11-16T24:00:00', new Date('nope'), 1794812400000]) {
			await assert.rejects(run(send(sendAt), SCHEDULED), (error) => {
				assert.ok(error instanceof NodeOperationError, String(sendAt));
				assert.match(error.message, /^Send At /);
				return true;
			});
		}
		const { output, calls } = await run(send('2026-02-30T09:00:00Z'), SCHEDULED, { continueOnFail: true });
		assert.deepEqual(output, [{ error: 'Send At "2026-02-30T09:00:00Z" is not a real date and time.' }]);
		assert.equal(calls.length, 0);
	});

	it('is refused on the sign-in code and several-recipient operations, which send right away', async () => {
		// The several-recipient operation and its To field, found by what n8n shows (their stored names are older).
		const { properties } = new SmsTunnel().description;
		const messageOperations = properties.find((p) => p.name === 'operation' && p.displayOptions.show.resource[0] === 'message');
		const several = messageOperations.options.find((o) => o.name === 'Send to Several Recipients').value;
		const severalTo = properties.find((p) => p.displayName === 'To' && p.displayOptions.show.operation.join() === several).name;
		for (const operation of ['send2fa', several]) {
			const params = { ...send('2026-11-16T09:00:00+02:00'), operation, [severalTo]: '+40712345678, +40712345679' };
			const { output, calls } = await run(params, SCHEDULED, { continueOnFail: true });
			assert.match(output[0].error, /Only the Send operation schedules a text/, operation);
			assert.equal(calls.length, 0, operation);
		}
	});

	it('is left alone by the operations that send nothing', async () => {
		const params = { resource: 'message', operation: 'getStatus', messageId: 'm1', additionalFields: { sendAt: 'not a date' } };
		const { calls } = await run(params, () => [200, { success: true, data: { id: 'm1', status: 'sent' } }]);
		assert.equal(calls[0].method, 'GET');
		assert.equal(calls[0].url, 'https://smstunnel.test/api/v1/sms/status/m1');
	});
});

describe('Scheduled Text', () => {
	it('Get Many lists the texts this key scheduled, with scope, page and limit', async () => {
		const page = { success: true, data: { items: [scheduledText()], total: 1, page: 1, limit: 50, waiting: 3, max: 10 } };
		const { output, calls } = await run({ resource: 'scheduledText', operation: 'getAll' }, () => [200, page]);
		assert.equal(calls[0].method, 'GET');
		assert.equal(calls[0].url, 'https://smstunnel.test/api/v1/sms/scheduled');
		assert.deepEqual(calls[0].qs, { scope: 'waiting', page: 1, limit: 50 });
		assert.equal(calls[0].body, undefined);
		assert.deepEqual(output, [page]);

		const done = await run({ resource: 'scheduledText', operation: 'getAll', scope: 'done', page: 2, limit: 20 }, () => [200, page]);
		assert.deepEqual(done.calls[0].qs, { scope: 'done', page: 2, limit: 20 });
	});

	it('Get reads one, and Cancel cancels it', async () => {
		const get = await run({ resource: 'scheduledText', operation: 'get', scheduledId: ` ${ID} ` }, () => [200, { success: true, data: scheduledText() }]);
		assert.equal(get.calls[0].method, 'GET');
		assert.equal(get.calls[0].url, `https://smstunnel.test/api/v1/sms/scheduled/${ID}`);
		assert.deepEqual(get.output, [{ success: true, data: scheduledText() }]);

		const cancel = await run({ resource: 'scheduledText', operation: 'cancel', scheduledId: ID }, () => [
			200,
			{ success: true, data: scheduledText({ status: 'canceled' }) },
		]);
		assert.equal(cancel.calls[0].method, 'DELETE');
		assert.equal(cancel.calls[0].url, `https://smstunnel.test/api/v1/sms/scheduled/${ID}`);
		assert.equal(cancel.calls[0].body, undefined);
		assert.equal(cancel.output[0].data.status, 'canceled');

		const odd = await run({ resource: 'scheduledText', operation: 'get', scheduledId: 'a/b?c' }, () => [200, { success: true }]);
		assert.equal(odd.calls[0].url, 'https://smstunnel.test/api/v1/sms/scheduled/a%2Fb%3Fc');
	});

	it('an empty ID stops the item before anything is asked', async () => {
		const { output, calls } = await run({ resource: 'scheduledText', operation: 'cancel', scheduledId: '  ' }, undefined, { continueOnFail: true });
		assert.match(output[0].error, /The Scheduled Text ID is empty/);
		assert.equal(calls.length, 0);
	});
});

describe('errors', () => {
	it("with Continue On Fail, keep SMSTunnel's code, words and status next to n8n's message", async () => {
		const answers = {
			'+40712345601': [400, { statusCode: 400, error: 'Bad Request', code: 'SCHEDULE_TOO_SOON', message: 'Pick a time at least a minute from now. To send it now, use Send.' }],
			'+40712345602': [403, { statusCode: 403, error: 'Forbidden', code: 'SCHEDULE_LIMIT_REACHED', message: 'You have as many scheduled texts as your plan allows.', max: 10 }],
			// The server before scheduled texts.
			'+40712345603': [400, { statusCode: 400, error: 'Bad Request', message: ['property sendAt should not exist'] }],
		};
		const numbers = Object.keys(answers);
		const { output } = await run(
			(i) => ({ ...send('2026-11-16T09:00:00+02:00'), to: numbers[i] }),
			(options) => answers[options.body.to],
			{ items: numbers.length, continueOnFail: true },
		);
		assert.deepEqual(output, [
			{ error: 'Bad request - please check your parameters', code: 'SCHEDULE_TOO_SOON', httpCode: '400', description: 'Pick a time at least a minute from now. To send it now, use Send.' },
			{ error: 'Forbidden - perhaps check your credentials?', code: 'SCHEDULE_LIMIT_REACHED', httpCode: '403', description: 'You have as many scheduled texts as your plan allows.' },
			{ error: 'Bad request - please check your parameters', httpCode: '400', description: 'property sendAt should not exist' },
		]);

		const late = await run({ resource: 'scheduledText', operation: 'cancel', scheduledId: ID }, () => [
			409,
			{ statusCode: 409, error: 'Conflict', code: 'SCHEDULE_NOT_EDITABLE', message: 'This text has already gone out or was canceled.' },
		], { continueOnFail: true });
		assert.equal(late.output[0].code, 'SCHEDULE_NOT_EDITABLE');
		assert.equal(late.output[0].httpCode, '409');
	});

	it('without Continue On Fail, stop the workflow with the NodeApiError, its code in the context', async () => {
		await assert.rejects(
			run({ resource: 'scheduledText', operation: 'get', scheduledId: ID }, () => [404, { statusCode: 404, error: 'Not Found', code: 'SCHEDULE_NOT_FOUND', message: 'This scheduled text no longer exists.' }]),
			(error) => {
				assert.ok(error instanceof NodeApiError);
				assert.equal(error.httpCode, '404');
				assert.equal(error.context.data.code, 'SCHEDULE_NOT_FOUND');
				assert.equal(error.description, 'This scheduled text no longer exists.');
				return true;
			},
		);
	});
});

describe('the node description', () => {
	const { properties } = new SmsTunnel().description;

	it('offers Send At on Send only, as a date and time', () => {
		const fields = properties.find((p) => p.name === 'additionalFields');
		const sendAt = fields.options.find((o) => o.name === 'sendAt');
		assert.equal(sendAt.type, 'dateTime');
		assert.equal(sendAt.default, '');
		assert.deepEqual(sendAt.displayOptions, { show: { '/operation': ['send'] } });
		assert.deepEqual(fields.options.map((o) => o.displayName), ['Default Country Code', 'Device ID', 'Send At']);
	});

	it('has the Scheduled Text resource with Cancel, Get and Get Many', () => {
		const resource = properties.find((p) => p.name === 'resource');
		assert.ok(resource.options.some((o) => o.value === 'scheduledText'));
		const operations = properties.find((p) => p.name === 'operation' && p.displayOptions?.show?.resource?.[0] === 'scheduledText');
		assert.deepEqual(operations.options.map((o) => o.value), ['cancel', 'get', 'getAll']);
		for (const name of ['scheduledId', 'scope', 'limit', 'page']) {
			assert.equal(properties.find((p) => p.name === name).displayOptions.show.resource[0], 'scheduledText', name);
		}
	});
});
