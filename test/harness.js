// A stand-in for n8n's execute context, for running the SMSTunnel node in tests. Every HTTP call goes through the
// credentials' own authenticate() (as n8n's httpRequestWithAuthentication does), is recorded and is answered here. An
// error status is thrown as n8n's helper throws it (a NodeApiError around the HTTP error), or, for a request that asks
// for the full response and to ignore HTTP errors, returned as { statusCode, headers, body }. Runs on dist/ (npm test
// builds it first), what the package ships.
const assert = require('node:assert/strict');
const { NodeApiError } = require('n8n-workflow');
const { SmsTunnel } = require('../dist/nodes/SmsTunnel/SmsTunnel.node.js');
const { SmsTunnelApi } = require('../dist/credentials/SmsTunnelApi.credentials.js');

const KEY = 'sk_' + 'live_' + '0123456789abcdef0123456789abcdef';
const ID = '6735a0c4e1d9e1b7b54cf994';
const BASE = 'https://smstunnel.test';

/** The node as a workflow stores it: typeVersion is the node version the run uses; as an AI tool, its type ends in Tool. */
const nodeOf = (typeVersion, type = 'n8n-nodes-smstunnel.smsTunnel') => ({
	id: 'n1',
	name: 'SMSTunnel',
	type,
	typeVersion,
	position: [0, 0],
	parameters: {},
});

/** What axios throws for an error status, as n8n's httpRequestWithAuthentication wraps it. */
class AxiosError extends Error {}
function apiError(node, status, body, headers = {}) {
	const cause = new AxiosError(`Request failed with status code ${status}`);
	cause.isAxiosError = true;
	cause.response = { status, data: body, headers };
	return new NodeApiError(node, cause);
}

/**
 * Runs the node once with `params` for every item (or `params(itemIndex)`). `answer(options, callNumber)` gives
 * [status, body, headers?] for each call. The node really waits for a Retry-After, so tests answer `Retry-After: 0`.
 */
async function run(
	params,
	answer = () => [200, { success: true }],
	{
		items = 1,
		timeZone = 'Europe/Bucharest',
		continueOnFail = false,
		version = 1,
		baseUrl = `${BASE}/`,
		credentials,
		type,
		toolExecution = false,
	} = {},
) {
	const calls = [];
	const node = nodeOf(version, type);
	const creds = credentials ?? { apiKey: KEY, baseUrl };
	const context = {
		getInputData: () => Array.from({ length: items }, () => ({ json: {} })),
		getCredentials: async () => creds,
		getNodeParameter(name, itemIndex, fallback) {
			const value = typeof params === 'function' ? params(itemIndex)[name] : params[name];
			if (value !== undefined) return value;
			if (arguments.length >= 3) return fallback;
			throw new Error(`Could not get parameter "${name}"`);
		},
		getNode: () => node,
		getTimezone: () => timeZone,
		continueOnFail: () => continueOnFail,
		isToolExecution: () => toolExecution,
		helpers: {
			async httpRequestWithAuthentication(credentialsType, options) {
				assert.equal(credentialsType, 'smsTunnelApi');
				const sent = await new SmsTunnelApi().authenticate(creds, options);
				calls.push(sent);
				const [status, body, headers = {}] = await answer(sent, calls.length);
				if (sent.returnFullResponse && sent.ignoreHttpStatusErrors) {
					return { statusCode: status, statusMessage: '', headers, body };
				}
				// axios takes only a 2xx as an answer (and the node follows no redirects).
				if (status < 200 || status > 299) throw apiError(node, status, body, headers);
				return sent.returnFullResponse ? { statusCode: status, statusMessage: '', headers, body } : body;
			},
		},
	};
	const [output] = await new SmsTunnel().execute.call(context);
	return { output: output.map((item) => item.json), paired: output.map((item) => item.pairedItem), calls };
}

module.exports = { KEY, ID, BASE, nodeOf, apiError, run };
