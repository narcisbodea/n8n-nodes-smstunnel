// The node as an AI Agent's tool: n8n runs it under its tool type (…smsTunnelTool). As a tool it only sends one text
// or reads what is not private; reading received texts, cancelling a scheduled text, sending a sign-in code and the
// several-recipients operation are refused, and hidden from the tool's operation list.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NodeHelpers, NodeOperationError } = require('n8n-workflow');
const { SmsTunnel } = require('../dist/nodes/SmsTunnel/SmsTunnel.node.js');
const { ID, nodeOf, run } = require('./harness');

const TOOL_TYPE = 'n8n-nodes-smstunnel.smsTunnelTool';
// The node versions to check.
const VERSIONS = [1, 2];
const asTool = { type: TOOL_TYPE };

const REFUSED = [
	['Get Received', { resource: 'message', operation: 'getReceived' }],
	['Send 2FA Code', { resource: 'message', operation: 'send2fa', to: '+14155550123', message: 'Your code is 123456', additionalFields: {} }],
	['Send to Several Recipients', { resource: 'message', operation: 'sendBulk', toBulk: '+14155550123', message: 'Hello', additionalFields: {} }],
	['Cancel', { resource: 'scheduledText', operation: 'cancel', scheduledId: ID }],
];

const ALLOWED = [
	['Send', { resource: 'message', operation: 'send', to: '+14155550123', message: 'Hello', additionalFields: {} }, 'POST', '/api/v1/sms/send'],
	[
		'Send with Send At',
		{ resource: 'message', operation: 'send', to: '+14155550123', message: 'Hello', additionalFields: { sendAt: '2026-11-18T09:00:00Z' } },
		'POST',
		'/api/v1/sms/send',
	],
	['Get Status', { resource: 'message', operation: 'getStatus', messageId: ID }, 'GET', `/api/v1/sms/status/${ID}`],
	['Get Usage', { resource: 'account', operation: 'getUsage' }, 'GET', '/api/v1/account/usage'],
	['Get Many phones', { resource: 'device', operation: 'getAll' }, 'GET', '/api/v1/devices'],
	['Get scheduled text', { resource: 'scheduledText', operation: 'get', scheduledId: ID }, 'GET', `/api/v1/sms/scheduled/${ID}`],
	['Get Many scheduled texts', { resource: 'scheduledText', operation: 'getAll' }, 'GET', '/api/v1/sms/scheduled'],
];

describe('as an AI tool', () => {
	it('refuses reading received texts, cancelling, sign-in codes and several recipients, before anything is sent', async () => {
		for (const version of VERSIONS) {
			for (const [name, params] of REFUSED) {
				if (version === 2 && params.operation === 'sendBulk') continue; // not in version 2 at all
				for (const options of [asTool, { toolExecution: true }]) {
					let calls = 0;
					await assert.rejects(
						run(params, () => {
							calls++;
							return [200, { success: true }];
						}, { ...options, version, continueOnFail: true }),
						(error) => {
							assert.ok(error instanceof NodeOperationError, name);
							assert.equal(error.message, `${name} is not available when SMSTunnel is used as an AI tool`);
							assert.match(error.description, /add SMSTunnel as a normal step of the workflow instead of as a tool of an AI Agent/);
							return true;
						},
					);
					assert.equal(calls, 0, name);
				}
			}
		}
	});

	it('still sends one text, and reads statuses, phones, usage and scheduled texts', async () => {
		for (const version of VERSIONS) {
			for (const [name, params, method, path] of ALLOWED) {
				const { calls, output } = await run(params, () => [200, { success: true, data: {} }], { ...asTool, version });
				assert.equal(calls.length, 1, name);
				assert.equal(calls[0].method, method, name);
				assert.equal(calls[0].url, `https://smstunnel.test${path}`, name);
				assert.deepEqual(output, [{ success: true, data: {} }], name);
			}
		}
	});

	it('the same operations all run in a normal workflow step', async () => {
		for (const [, params] of REFUSED) {
			const { calls } = await run(params, () => [200, { success: true, messageId: ID, data: { messageId: ID } }]);
			assert.ok(calls.length >= 1, params.operation);
		}
	});

	it("hides the refused operations from the tool's operation list, not from the node's", () => {
		const { description } = new SmsTunnel();
		const toolDescription = { ...description, name: `${description.name}Tool` };
		for (const version of VERSIONS) {
			const node = nodeOf(version);
			const listed = (resource, typeDescription) =>
				description.properties
					.filter((p) => p.name === 'operation' && NodeHelpers.displayParameter({ resource }, p, node, typeDescription))
					.flatMap((p) => p.options)
					.filter((o) => !o.displayOptions || NodeHelpers.displayParameter({ resource }, o, node, typeDescription))
					.map((o) => o.value);
			const several = version === 1 ? ['sendBulk'] : [];
			assert.deepEqual(listed('message', description), ['getReceived', 'getStatus', 'send', 'send2fa', ...several], `v${version}`);
			assert.deepEqual(listed('message', toolDescription), ['getStatus', 'send'], `v${version}`);
			assert.deepEqual(listed('scheduledText', description), ['cancel', 'get', 'getAll'], `v${version}`);
			assert.deepEqual(listed('scheduledText', toolDescription), ['get', 'getAll'], `v${version}`);
			assert.deepEqual(listed('account', toolDescription), ['getUsage'], `v${version}`);
			assert.deepEqual(listed('device', toolDescription), ['getAll'], `v${version}`);
		}
	});
});
