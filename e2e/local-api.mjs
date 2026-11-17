// End to end against a LOCAL SMSTunnel API (never production): runs the built node (dist/) with real HTTP and sends
// real texts through the API to its simulated phone. Not part of `npm test` and not published.
//
//   npm run build
//   SMSTUNNEL_E2E_BASE_URL=http://127.0.0.1:3172 SMSTUNNEL_E2E_API_KEY=sk_live_… node e2e/local-api.mjs
//
// SMSTUNNEL_E2E_API_KEY2 (optional): a second, unused key of the same account, for the per-minute limit check (32
// texts in a row: about a minute). Prints one JSON line per check and a summary; exits 1 if a check fails.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NodeApiError } = require('n8n-workflow');
const { SmsTunnel } = require('../dist/nodes/SmsTunnel/SmsTunnel.node.js');
const { SmsTunnelApi } = require('../dist/credentials/SmsTunnelApi.credentials.js');
const { requestTarget } = require('../dist/nodes/SmsTunnel/GenericFunctions.js');

const BASE = process.env.SMSTUNNEL_E2E_BASE_URL ?? '';
const KEY = process.env.SMSTUNNEL_E2E_API_KEY ?? '';
const KEY2 = process.env.SMSTUNNEL_E2E_API_KEY2 ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) throw new Error('Only a local API: SMSTUNNEL_E2E_BASE_URL=http://127.0.0.1:<port>');
if (!KEY) throw new Error('Set SMSTUNNEL_E2E_API_KEY to a key of the local API');

/** What axios throws for an error status; n8n's helper wraps it in a NodeApiError. */
class AxiosError extends Error {}

/** n8n's httpRequestWithAuthentication for this node: the credentials' authenticate(), then the request. */
async function httpRequestWithAuthentication(node, credentials, options) {
	const sent = await new SmsTunnelApi().authenticate(credentials, options);
	// baseURL and url joined as axios joins them (the credentials' Test gives them apart).
	const url = new URL(requestTarget(sent));
	for (const [name, value] of Object.entries(sent.qs ?? {})) url.searchParams.set(name, String(value));
	const response = await fetch(url, {
		method: sent.method ?? 'GET',
		headers: { Accept: 'application/json', ...(sent.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...sent.headers },
		body: sent.body !== undefined ? JSON.stringify(sent.body) : undefined,
		redirect: sent.disableFollowRedirect ? 'manual' : 'follow',
	});
	const text = await response.text();
	let body = text;
	try {
		body = text ? JSON.parse(text) : '';
	} catch {}
	const headers = Object.fromEntries(response.headers.entries());
	if (sent.returnFullResponse && sent.ignoreHttpStatusErrors) return { statusCode: response.status, statusMessage: response.statusText, headers, body };
	if (response.status < 200 || response.status > 299) {
		const cause = new AxiosError(`Request failed with status code ${response.status}`);
		cause.isAxiosError = true;
		cause.response = { status: response.status, data: body, headers };
		throw new NodeApiError(node, cause);
	}
	return sent.returnFullResponse ? { statusCode: response.status, headers, body } : body;
}

/** Runs the node once over `items` items, as n8n would for a node of `version`. */
async function runNode(params, { version = 2, items = 1, key = KEY, continueOnFail = false } = {}) {
	const node = { id: 'e2e', name: 'SMSTunnel', type: 'n8n-nodes-smstunnel.smsTunnel', typeVersion: version, position: [0, 0], parameters: {} };
	const credentials = { apiKey: key, baseUrl: BASE };
	const context = {
		getInputData: () => Array.from({ length: items }, () => ({ json: {} })),
		getCredentials: async () => credentials,
		getNodeParameter(name, itemIndex, fallback) {
			const value = typeof params === 'function' ? params(itemIndex)[name] : params[name];
			if (value !== undefined) return value;
			if (arguments.length >= 3) return fallback;
			throw new Error(`Could not get parameter "${name}"`);
		},
		getNode: () => node,
		getTimezone: () => 'Europe/Bucharest',
		continueOnFail: () => continueOnFail,
		isToolExecution: () => false,
		helpers: { httpRequestWithAuthentication: (type, options) => httpRequestWithAuthentication(node, credentials, options) },
	};
	const [output] = await new SmsTunnel().execute.call(context);
	return output.map((item) => item.json);
}

const results = [];
async function check(name, fn) {
	const started = Date.now();
	try {
		const detail = await fn();
		results.push({ name, ok: true });
		console.log(JSON.stringify({ check: name, ok: true, ms: Date.now() - started, ...detail }));
	} catch (error) {
		results.push({ name, ok: false });
		console.log(JSON.stringify({ check: name, ok: false, ms: Date.now() - started, error: error.message, description: error.description }));
	}
}
const assert = (condition, message) => {
	if (!condition) throw new Error(message);
};
const isId = (value) => typeof value === 'string' && /^[0-9a-f]{24}$/.test(value);
const message = { resource: 'message', additionalFields: {} };
const sentIds = [];

await check("credentials' Test (GET /api/v1/account/usage through authenticate)", async () => {
	const { request } = new SmsTunnelApi().test;
	const answer = await httpRequestWithAuthentication({}, { apiKey: KEY, baseUrl: BASE }, { baseURL: BASE, url: request.url, method: request.method });
	assert(answer?.success === true, 'usage did not answer success');
	return { plan: answer.data?.plan };
});

await check('version 1: Send', async () => {
	const [out] = await runNode({ ...message, operation: 'send', to: '+14155550123', message: 'n8n e2e v1 Send' }, { version: 1 });
	assert(out.success === true && isId(out.messageId), `no messageId: ${JSON.stringify(out)}`);
	sentIds.push(out.messageId);
	return { messageId: out.messageId };
});

await check('version 1: Send to Several Recipients (one POST /api/v1/sms/send per number)', async () => {
	const [out] = await runNode(
		{ ...message, operation: 'sendBulk', toBulk: '+14155550124, +14155550125; +14155550126', message: 'n8n e2e v1 Send to Several Recipients' },
		{ version: 1 },
	);
	const { data } = out;
	assert(out.success === true, 'not success');
	assert(Array.isArray(data.messageIds) && data.messageIds.length === 3 && data.messageIds.every(isId), `messageIds: ${JSON.stringify(data.messageIds)}`);
	assert(data.count === 3 && typeof data.branded === 'boolean' && data.remaining !== undefined, `shape: ${JSON.stringify(data)}`);
	assert(data.refused === undefined, `refused: ${JSON.stringify(data.refused)}`);
	sentIds.push(...data.messageIds);
	return { keys: Object.keys(data), count: data.count };
});

await check('version 1: Send to Several Recipients, a number the server refuses', async () => {
	const [out] = await runNode(
		{ ...message, operation: 'sendBulk', toBulk: '+14155550127, 12, +14155550128', message: 'n8n e2e v1 with a refused number' },
		{ version: 1 },
	);
	assert(out.data.count === 2 && out.data.refused?.length === 1 && out.data.refused[0] === '12', JSON.stringify(out.data));
	sentIds.push(...out.data.messageIds);
	return { refused: out.data.refused, error: out.data.error };
});

await check('version 2: Send, one text per item (3 items)', async () => {
	const numbers = ['+14155550131', '+14155550132', '+14155550133'];
	const out = await runNode((i) => ({ ...message, operation: 'send', to: numbers[i], message: `n8n e2e v2 Send item ${i + 1}` }), { items: 3 });
	assert(out.length === 3 && out.every((o) => o.success === true && isId(o.messageId)), JSON.stringify(out));
	sentIds.push(...out.map((o) => o.messageId));
	return { messageIds: out.map((o) => o.messageId) };
});

await check('version 2: Send 2FA Code', async () => {
	const [out] = await runNode({ ...message, operation: 'send2fa', to: '+14155550134', message: 'Your n8n e2e code is 482913' });
	assert(out.success === true && isId(out.messageId), JSON.stringify(out));
	sentIds.push(out.messageId);
	return { messageId: out.messageId };
});

await check('version 2: Get Status, Get Usage, Device Get Many', async () => {
	const [status] = await runNode({ resource: 'message', operation: 'getStatus', messageId: sentIds[0] });
	const [usage] = await runNode({ resource: 'account', operation: 'getUsage' });
	const [devices] = await runNode({ resource: 'device', operation: 'getAll' });
	assert(status.success === true && status.data?.status, JSON.stringify(status));
	assert(usage.success === true, JSON.stringify(usage));
	assert(Array.isArray(devices.data?.devices) && devices.data.devices.length > 0, JSON.stringify(devices));
	return { status: status.data.status, phones: devices.data.devices.length, online: devices.data.devices.filter((d) => d.isOnline).length };
});

await check('version 2: Send with Send At, then Scheduled Text Get, Get Many and Cancel', async () => {
	const sendAt = new Date(Date.now() + 15 * 60000).toISOString();
	const [scheduled] = await runNode({ ...message, operation: 'send', to: '+14155550135', message: 'n8n e2e scheduled', additionalFields: { sendAt } });
	assert(scheduled.scheduled === true && isId(scheduled.scheduledId), JSON.stringify(scheduled));
	const [got] = await runNode({ resource: 'scheduledText', operation: 'get', scheduledId: scheduled.scheduledId });
	const [many] = await runNode({ resource: 'scheduledText', operation: 'getAll' });
	const [canceled] = await runNode({ resource: 'scheduledText', operation: 'cancel', scheduledId: scheduled.scheduledId });
	assert(got.data?.id === scheduled.scheduledId, JSON.stringify(got));
	assert(many.data?.items?.some((s) => s.id === scheduled.scheduledId), JSON.stringify(many));
	assert(canceled.data?.status === 'canceled', JSON.stringify(canceled));
	return { scheduledId: scheduled.scheduledId, status: canceled.data.status };
});

await check('the ids are checked before anything is asked', async () => {
	const out = await runNode({ resource: 'message', operation: 'getStatus', messageId: '../account/usage' }, { continueOnFail: true });
	assert(out[0].error === 'The Message ID is not an ID from SMSTunnel', JSON.stringify(out));
	return { error: out[0].error };
});

await check('the server honours the Idempotency-Key the node sends: same key, same text, same answer', async () => {
	const key = `n8n-smstunnel-e2e-${Date.now()}`;
	const post = () =>
		fetch(`${BASE}/api/v1/sms/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY, 'Idempotency-Key': key },
			body: JSON.stringify({ to: '+14155550136', message: 'n8n e2e idempotency' }),
		});
	const first = await post();
	const firstBody = await first.json();
	const again = await post();
	const againBody = await again.json();
	assert(first.status === 200 && again.status === 200, `${first.status} ${again.status}`);
	assert(firstBody.messageId === againBody.messageId, 'a second text was made');
	assert(again.headers.get('idempotent-replayed') === 'true', 'not replayed');
	sentIds.push(firstBody.messageId);
	return { messageId: firstBody.messageId, replayed: again.headers.get('idempotent-replayed') };
});

if (KEY2) {
	await check("version 2: 32 items with one key: waits for the per-minute limit's Retry-After, then sends the rest", async () => {
		const n = 32;
		const out = await runNode((i) => ({ ...message, operation: 'send', to: `+1415555${String(200 + i).padStart(4, '0')}`, message: `n8n e2e limit ${i + 1}` }), {
			items: n,
			key: KEY2,
			continueOnFail: true,
		});
		const sent = out.filter((o) => o.success === true && isId(o.messageId));
		const failed = out.filter((o) => o.error);
		sentIds.push(...sent.map((o) => o.messageId));
		assert(sent.length === n, `${sent.length} of ${n} sent; first refusal: ${JSON.stringify(failed[0])}`);
		return { sent: sent.length };
	});
}

console.log(JSON.stringify({ summary: true, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, messageIds: sentIds }));
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
