import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	IN8nHttpFullResponse,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

import { checkBaseUrl, checkId, retryAfterMs } from './GenericFunctions';

/**
 * Splits a comma/semicolon/newline separated list of phone numbers into a clean array.
 */
function parseRecipients(raw: string): string[] {
	return raw
		.split(/[,;\n]/)
		.map((n) => n.trim())
		.filter((n) => n.length > 0);
}

// YYYY-MM-DD, T (or a space), hh:mm, optional :ss and a fraction, then the offset: Z, ±hh:mm, ±hhmm, ±hh, or none.
const ISO_DATE_TIME =
	/^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(?:([Zz])|([+-])(\d{2})(?::?(\d{2}))?)?$/;

/** Send At as SMSTunnel takes it (`value`, none when the field is empty), or what is wrong with it. */
type SendAtCheck = { ok: true; value?: string } | { ok: false; error: string };

/**
 * Send At as SMSTunnel takes it: a full ISO 8601 date and time, always sent as toISOString() (UTC). A time with its
 * offset is taken as it is. n8n's date picker gives one without (2026-11-16T09:00:00): that one is read in the
 * workflow's time zone, as n8n's own nodes read it. Anything that is not a real date and time is refused, such as
 * 30 February (new Date() would quietly make it 2 March). Whether it is 1 minute to 30 days ahead is left to
 * SMSTunnel, whose clock decides.
 */
function sendAtOf(value: unknown, timeZone: string): SendAtCheck {
	if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
		return { ok: true };
	}
	if (value instanceof Date || Object.prototype.toString.call(value) === '[object Date]') {
		const time = Date.prototype.getTime.call(value);
		if (Number.isNaN(time)) return { ok: false, error: 'Send At is not a valid date.' };
		return { ok: true, value: new Date(time).toISOString() };
	}
	// An expression may give a Luxon DateTime ({{ $now.plus({ hours: 2 }) }}): its ISO text has the offset.
	const text =
		typeof value === 'object' && typeof (value as { toISO?: unknown }).toISO === 'function'
			? (value as { toISO(): string | null }).toISO()
			: value;
	const parts = typeof text === 'string' ? ISO_DATE_TIME.exec(text.trim()) : null;
	if (!parts) {
		return {
			ok: false,
			error: `Send At must be a date and time, such as 2026-11-16T09:00:00 or 2026-11-16T09:00:00+02:00 (got ${JSON.stringify(String(text)).slice(0, 60)}).`,
		};
	}
	const [, year, month, day, hour, minute, second = '00', fraction = '', zulu, sign, offsetHours = '00', offsetMinutes = '00'] =
		parts;
	const wallText = `${year}-${month}-${day}T${hour}:${minute}:${second}.${(fraction + '000').slice(0, 3)}Z`;
	const wall = Date.parse(wallText);
	if (Number.isNaN(wall) || new Date(wall).toISOString() !== wallText || Number(offsetHours) > 23 || Number(offsetMinutes) > 59) {
		return { ok: false, error: `Send At ${JSON.stringify(text)} is not a real date and time.` };
	}
	if (zulu || sign) {
		const offset = sign ? (sign === '-' ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes)) : 0;
		return { ok: true, value: new Date(wall - offset * 60000).toISOString() };
	}
	// Without an offset: that wall-clock time in the workflow's time zone. A second pass settles a time next to a
	// daylight-saving change.
	try {
		const first = wall - zoneOffsetMinutes(wall, timeZone) * 60000;
		return { ok: true, value: new Date(wall - zoneOffsetMinutes(first, timeZone) * 60000).toISOString() };
	} catch {
		return {
			ok: false,
			error: `Send At has no offset and the workflow's time zone (${JSON.stringify(timeZone)}) is not known: add the offset, such as +02:00.`,
		};
	}
}

/** How far `timeZone` is ahead of UTC at the instant `utc`, in minutes. */
function zoneOffsetMinutes(utc: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).formatToParts(new Date(utc));
	const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	const local = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
	return Math.round((local - Math.floor(utc / 1000) * 1000) / 60000);
}

/**
 * The item a failed call gives with Continue On Fail: n8n's words in `error`, as before, and when SMSTunnel answered,
 * its own words (`description`), its `code` (such as SCHEDULE_TOO_SOON) and the HTTP status (`httpCode`).
 */
function errorJson(error: unknown): IDataObject {
	const json: IDataObject = { error: (error as Error).message };
	const { description, httpCode, context } = (error ?? {}) as {
		description?: unknown;
		httpCode?: unknown;
		context?: { data?: unknown };
	};
	const data = context?.data;
	if (data && typeof data === 'object' && typeof (data as IDataObject).code === 'string') {
		json.code = (data as IDataObject).code;
	}
	if (typeof httpCode === 'string' && httpCode) json.httpCode = httpCode;
	// SMSTunnel sends a list when it refuses several fields (and NodeApiError keeps it as it is).
	const words = Array.isArray(description) ? description.filter((part) => typeof part === 'string').join('; ') : description;
	if (typeof words === 'string' && words && words !== json.error) json.description = words;
	return json;
}

/** How many times one request waits for SMSTunnel's per-minute limit (Retry-After) before the node gives up on it. */
const RATE_LIMIT_WAITS = 3;

/**
 * One request that waits when SMSTunnel's per-minute limit for the key says so (a 429 with Retry-After: the request
 * wasn't handled, nothing was sent) and then asks again, up to RATE_LIMIT_WAITS times. A 429 without Retry-After is
 * the plan's daily limit and is not waited for. An HTTP error comes back as the NodeApiError n8n's helper makes.
 */
async function requestWaitingForLimit(
	context: IExecuteFunctions,
	options: IHttpRequestOptions,
	itemIndex: number,
): Promise<IDataObject> {
	for (let waits = 0; ; waits++) {
		const response = (await context.helpers.httpRequestWithAuthentication.call(context, 'smsTunnelApi', {
			...options,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		})) as IN8nHttpFullResponse;
		const status = Number(response.statusCode);
		if (status < 400) return response.body as IDataObject;
		const wait = status === 429 ? retryAfterMs(response.headers) : undefined;
		if (wait !== undefined && waits < RATE_LIMIT_WAITS) {
			await sleep(wait);
			continue;
		}
		// The same error n8n's helper throws for an HTTP error: its words, SMSTunnel's in the description and context.
		throw new NodeApiError(
			context.getNode(),
			{
				message: `Request failed with status code ${status}`,
				response: { status, data: response.body, headers: response.headers },
			} as JsonObject,
			{ httpCode: String(status), itemIndex },
		);
	}
}

/**
 * Version 1's Send to Several Recipients, one text per number: a POST /api/v1/sms/send for each, in order, waiting
 * for the per-minute limit when it says so. The output keeps the shape of the single request it used to be,
 * { success: true, data: { messageIds, branded, count, remaining } }, with `refused` (the numbers whose text didn't
 * go out) and `error` (why) when some didn't. A number SMSTunnel refuses (400) is skipped; any other refusal (the
 * plan's daily limit, the key, the server) stops the list there, and the rest is refused as well, as the daily limit
 * did. When no text went out at all, the item fails with the first refusal, as the single request did.
 */
async function sendToSeveral(
	context: IExecuteFunctions,
	itemIndex: number,
	url: string,
	recipients: string[],
	fields: Record<string, unknown>,
): Promise<IDataObject> {
	const messageIds: string[] = [];
	const refused: string[] = [];
	const reasons: string[] = [];
	let branded = false;
	let remaining: unknown;
	let first: unknown;
	for (const [index, to] of recipients.entries()) {
		try {
			const answer = await requestWaitingForLimit(
				context,
				{ method: 'POST', url, json: true, body: { to, ...fields } },
				itemIndex,
			);
			const data = (answer?.data ?? {}) as IDataObject;
			const messageId = answer?.messageId ?? data.messageId;
			if (typeof messageId === 'string') messageIds.push(messageId);
			branded = branded || data.branded === true;
			if (data.remaining !== undefined) remaining = data.remaining;
		} catch (error) {
			first = first ?? error;
			const said = errorJson(error);
			const why = String(said.description ?? said.error);
			if (!reasons.includes(why)) reasons.push(why);
			if ((error as NodeApiError).httpCode === '400') {
				refused.push(to);
				continue;
			}
			refused.push(...recipients.slice(index));
			break;
		}
	}
	if (messageIds.length === 0 && first !== undefined) {
		throw first instanceof NodeApiError || first instanceof NodeOperationError
			? first
			: new NodeApiError(context.getNode(), first as JsonObject, { itemIndex });
	}
	return {
		success: true,
		data: {
			messageIds,
			branded,
			count: messageIds.length,
			remaining,
			...(refused.length > 0 ? { refused, error: reasons.join('; ') } : {}),
		},
	};
}

/**
 * What an AI Agent may not do with this node as its tool, and why: everything else only sends one text, or reads
 * nothing private (a text's status, the phones, the usage, the texts this key scheduled).
 */
const NOT_AS_TOOL: Record<string, Record<string, { name: string; why: string } | undefined> | undefined> = {
	message: {
		getReceived: {
			name: 'Get Received',
			why: 'Received texts often hold sign-in codes and other private words, and a model can be talked into passing them on.',
		},
		send2fa: {
			name: 'Send 2FA Code',
			why: 'Sign-in codes belong to your own sign-in flows, not to a model.',
		},
		sendBulk: {
			name: 'Send to Several Recipients',
			why: 'As a tool, one call sends one text to one person.',
		},
	},
	scheduledText: {
		cancel: {
			name: 'Cancel',
			why: 'A model could cancel the texts you scheduled.',
		},
	},
};

/** Hides an operation from the AI tool's list (n8n's "@tool"; an older n8n shows it, and the run refuses it). */
const HIDDEN_AS_TOOL = { hide: { '@tool': [true] } };

/**
 * Whether n8n runs the node as an AI Agent's tool. It always does so under the tool type
 * (n8n-nodes-smstunnel.smsTunnelTool), however the agent calls it; the context says so as well when the agent calls
 * the tool directly.
 */
function runsAsTool(context: IExecuteFunctions): boolean {
	const type = String(context.getNode().type ?? '');
	if ((type.split('.').pop() ?? '').endsWith('Tool')) return true;
	return typeof context.isToolExecution === 'function' && context.isToolExecution() === true;
}

export class SmsTunnel implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SMSTunnel',
		name: 'smsTunnel',
		// One icon that reads well on both themes (white bubble on a blue tile).
		icon: { light: 'file:smstunnel.svg', dark: 'file:smstunnel.svg' },
		group: ['output'],
		// Version 2 sends one text per item: it has no Send to Several Recipients. Workflows saved with version 1 keep
		// it, and new nodes are version 2.
		version: [1, 2],
		defaultVersion: 2,
		// The operation and resource as n8n shows them, not their stored values.
		subtitle:
			'={{ ({ send: "Send", send2fa: "Send 2FA Code", sendBulk: "Send to Several Recipients", getStatus: "Get Status", getReceived: "Get Received", getUsage: "Get Usage", getAll: "Get Many", get: "Get", cancel: "Cancel" })[$parameter["operation"]] + ": " + ({ message: "Message", account: "Account", device: "Device", scheduledText: "Scheduled Text" })[$parameter["resource"]] }}',
		description: 'Send SMS through your own Android phone via SMSTunnel',
		defaults: {
			name: 'SMSTunnel',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'smsTunnelApi',
				required: true,
			},
		],
		properties: [
			// ─────────────────────────── Resource ───────────────────────────
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Message', value: 'message' },
					{ name: 'Account', value: 'account' },
					{ name: 'Device', value: 'device' },
					{ name: 'Scheduled Text', value: 'scheduledText' },
				],
				default: 'message',
			},

			// ─────────────────────────── Operations ───────────────────────────
			// Message, version 2: one text per item, so no Send to Several Recipients.
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['message'], '@version': [{ _cnd: { gte: 2 } }] } },
				options: [
					{
						name: 'Get Received',
						value: 'getReceived',
						description: 'Get received SMS synced from your phone (only if sync is on in the app)',
						action: 'Get received messages',
						displayOptions: HIDDEN_AS_TOOL,
					},
					{
						name: 'Get Status',
						value: 'getStatus',
						description: 'Get the delivery status of a sent message',
						action: 'Get a message status',
					},
					{
						name: 'Send',
						value: 'send',
						description: 'Send an SMS to a single recipient, now or at a later time',
						action: 'Send an SMS',
					},
					{
						name: 'Send 2FA Code',
						value: 'send2fa',
						description: 'Send a one-time verification code (uses the 2FA quota)',
						action: 'Send a 2FA code',
						displayOptions: HIDDEN_AS_TOOL,
					},
				],
				default: 'send',
			},
			// Message, version 1: as saved workflows have it, with Send to Several Recipients.
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['message'], '@version': [1] } },
				options: [
					{
						name: 'Get Received',
						value: 'getReceived',
						description: 'Get received SMS synced from your phone (only if sync is on in the app)',
						action: 'Get received messages',
						displayOptions: HIDDEN_AS_TOOL,
					},
					{
						name: 'Get Status',
						value: 'getStatus',
						description: 'Get the delivery status of a sent message',
						action: 'Get a message status',
					},
					{
						name: 'Send',
						value: 'send',
						description: 'Send an SMS to a single recipient, now or at a later time',
						action: 'Send an SMS',
					},
					{
						name: 'Send 2FA Code',
						value: 'send2fa',
						description: 'Send a one-time verification code (uses the 2FA quota)',
						action: 'Send a 2FA code',
						displayOptions: HIDDEN_AS_TOOL,
					},
					{
						// Version 1 only. Display text only: the value stays 'sendBulk' because saved workflows store it.
						name: 'Send to Several Recipients',
						value: 'sendBulk',
						description: 'Send the same SMS to up to 100 numbers, one text to each',
						action: 'Send an SMS to several recipients',
						displayOptions: HIDDEN_AS_TOOL,
					},
				],
				default: 'send',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['account'] } },
				options: [
					{
						name: 'Get Usage',
						value: 'getUsage',
						description: 'Get the current quota and usage of the account',
						action: 'Get account usage',
					},
				],
				default: 'getUsage',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['device'] } },
				options: [
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'Get the devices paired with this account',
						action: 'Get many devices',
					},
				],
				default: 'getAll',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['scheduledText'] } },
				options: [
					{
						name: 'Cancel',
						value: 'cancel',
						description: 'Cancel a scheduled text before it goes out',
						action: 'Cancel a scheduled text',
						displayOptions: HIDDEN_AS_TOOL,
					},
					{
						name: 'Get',
						value: 'get',
						description: 'Get a scheduled text by its ID',
						action: 'Get a scheduled text',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'Get the texts this API key scheduled',
						action: 'Get many scheduled texts',
					},
				],
				default: 'getAll',
			},

			// ─────────────────────────── message: send / send2fa ───────────────────────────
			{
				displayName: 'To',
				name: 'to',
				type: 'string',
				required: true,
				default: '',
				placeholder: '+40712345678',
				description:
					'Recipient phone number. Use international format, or set a default country code below.',
				displayOptions: { show: { resource: ['message'], operation: ['send', 'send2fa'] } },
			},

			// ─────────────────────────── message: sendBulk (version 1) ───────────────────────────
			{
				displayName: 'To',
				name: 'toBulk',
				type: 'string',
				required: true,
				default: '',
				placeholder: '+40712345678, +40787654321',
				description:
					'Phone numbers, separated by comma, semicolon or newline, at most 100. Each number gets its own text.',
				displayOptions: { show: { resource: ['message'], operation: ['sendBulk'], '@version': [1] } },
			},

			// ─────────────────────────── message body ───────────────────────────
			{
				displayName: 'Message',
				name: 'message',
				type: 'string',
				typeOptions: { rows: 4 },
				required: true,
				default: '',
				description: 'Text of the message. Maximum 1600 characters (10 concatenated SMS).',
				displayOptions: { show: { resource: ['message'], operation: ['send', 'sendBulk'] } },
			},
			{
				displayName: 'Message',
				name: 'message',
				type: 'string',
				typeOptions: { rows: 3 },
				required: true,
				default: '',
				placeholder: 'Your verification code is 12-345678',
				description:
					'Text of the verification message, maximum 320 characters. The server rejects the request if the text does not contain a valid code pattern.',
				displayOptions: { show: { resource: ['message'], operation: ['send2fa'] } },
			},

			// ─────────────────────────── message: getStatus ───────────────────────────
			{
				displayName: 'Message ID',
				name: 'messageId',
				type: 'string',
				required: true,
				default: '',
				description: 'ID returned when the message was sent',
				displayOptions: { show: { resource: ['message'], operation: ['getStatus'] } },
			},

			// ─────────────────────────── scheduledText: get / cancel ───────────────────────────
			{
				displayName: 'Scheduled Text ID',
				name: 'scheduledId',
				type: 'string',
				required: true,
				default: '',
				description: 'The scheduledId returned when the text was scheduled (Send with Send At)',
				displayOptions: { show: { resource: ['scheduledText'], operation: ['get', 'cancel'] } },
			},

			// ─────────────────────────── scheduledText: getAll ───────────────────────────
			{
				displayName: 'Scope',
				name: 'scope',
				type: 'options',
				options: [
					{
						name: 'Done',
						value: 'done',
						description: 'Sent, failed or canceled in the last 30 days, newest first',
					},
					{
						name: 'Waiting',
						value: 'waiting',
						description: 'Not gone out yet, soonest first',
					},
				],
				default: 'waiting',
				description:
					'Which scheduled texts to get. Only the texts scheduled with this API key are listed.',
				displayOptions: { show: { resource: ['scheduledText'], operation: ['getAll'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: { show: { resource: ['scheduledText'], operation: ['getAll'] } },
			},
			{
				displayName: 'Page',
				name: 'page',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 1,
				description: 'Page of results, from 1',
				displayOptions: { show: { resource: ['scheduledText'], operation: ['getAll'] } },
			},

			// ─────────────────────────── Additional options ───────────────────────────
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: {
					show: { resource: ['message'], operation: ['send', 'sendBulk', 'send2fa'] },
				},
				options: [
					{
						displayName: 'Default Country Code',
						name: 'defaultCountryCode',
						type: 'string',
						default: '',
						placeholder: '+40',
						description:
							'Prepended to numbers that do not already start with "+" or "00"',
					},
					{
						displayName: 'Device ID',
						name: 'deviceId',
						type: 'string',
						default: '',
						description:
							'Send through a specific paired device. Leave empty to let the server choose.',
					},
					{
						displayName: 'Send At',
						name: 'sendAt',
						type: 'dateTime',
						default: '',
						description:
							"Send the text later instead of now, 1 minute to 30 days ahead. A time without an offset is read in the workflow's time zone. The output then has the scheduledId for the Scheduled Text operations.",
						// Only the plain Send schedules: not sign-in codes, not texts to several recipients.
						displayOptions: { show: { '/operation': ['send'] } },
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('smsTunnelApi');
		// The API key goes to this address: https:// only (http:// for this computer), nothing but origin and path.
		const checkedBase = checkBaseUrl(credentials.baseUrl);
		if (!checkedBase.ok) {
			throw new NodeOperationError(this.getNode(), checkedBase.message, {
				description: checkedBase.description,
			});
		}
		const baseUrl = checkedBase.base;

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		// Version 2 waits when SMSTunnel's per-minute limit says so, so a long list of items (one text each) gets through.
		// Version 1 answers as it always did, except Send to Several Recipients (sendToSeveral).
		const waitForLimit = this.getNode().typeVersion >= 2;

		// As an AI Agent's tool the node only sends one text or reads what is not private (NOT_AS_TOOL).
		const refusedAsTool = runsAsTool(this) ? NOT_AS_TOOL[resource]?.[operation] : undefined;
		if (refusedAsTool) {
			throw new NodeOperationError(
				this.getNode(),
				`${refusedAsTool.name} is not available when SMSTunnel is used as an AI tool`,
				{
					description: `${refusedAsTool.why} To use ${refusedAsTool.name}, add SMSTunnel as a normal step of the workflow instead of as a tool of an AI Agent.`,
				},
			);
		}

		for (let i = 0; i < items.length; i++) {
			try {
				let method: IHttpRequestMethods = 'POST';
				let endpoint = '';
				let body: Record<string, unknown> | undefined;
				let qs: IDataObject | undefined;

				if (resource === 'message') {
					const additionalFields = this.getNodeParameter(
						'additionalFields',
						i,
						{},
					) as IDataObject;

					const extra: Record<string, unknown> = {};
					if (additionalFields.deviceId) extra.deviceId = additionalFields.deviceId;
					if (additionalFields.defaultCountryCode) {
						extra.defaultCountryCode = additionalFields.defaultCountryCode;
					}

					let sendAt: string | undefined;
					// The three send operations (Send, Send to Several Recipients, Send 2FA Code); the others send nothing.
					if (operation.startsWith('send')) {
						const checked = sendAtOf(additionalFields.sendAt, this.getTimezone());
						if (!checked.ok) {
							throw new NodeOperationError(this.getNode(), checked.error, { itemIndex: i });
						}
						if (checked.value && operation !== 'send') {
							throw new NodeOperationError(
								this.getNode(),
								'Only the Send operation schedules a text: sign-in codes and texts to several recipients go out right away. Remove Send At, or use Send.',
								{ itemIndex: i },
							);
						}
						sendAt = checked.value;
					}

					if (operation === 'send') {
						endpoint = '/api/v1/sms/send';
						body = {
							to: this.getNodeParameter('to', i) as string,
							message: this.getNodeParameter('message', i) as string,
							...extra,
							...(sendAt ? { sendAt } : {}),
						};
					} else if (operation === 'sendBulk') {
						if (waitForLimit) {
							throw new NodeOperationError(
								this.getNode(),
								'Send to Several Recipients is not in version 2 of the SMSTunnel node',
								{
									itemIndex: i,
									description:
										'Version 2 sends one text per item: put each number in its own item (for example with Split Out) and use Send.',
								},
							);
						}
						const recipients = parseRecipients(this.getNodeParameter('toBulk', i) as string);

						if (recipients.length === 0) {
							throw new NodeOperationError(
								this.getNode(),
								'No recipient phone number was provided',
								{ itemIndex: i },
							);
						}
						if (recipients.length > 100) {
							throw new NodeOperationError(
								this.getNode(),
								`Too many recipients (${recipients.length}): at most 100 per item. Split the numbers over several items.`,
								{ itemIndex: i },
							);
						}

						// One text per number, each its own POST /api/v1/sms/send.
						const several = await sendToSeveral(this, i, `${baseUrl}/api/v1/sms/send`, recipients, {
							message: this.getNodeParameter('message', i) as string,
							...extra,
						});
						returnData.push({ json: several, pairedItem: { item: i } });
						continue;
					} else if (operation === 'send2fa') {
						endpoint = '/api/v1/sms/send-2fa';
						body = {
							to: this.getNodeParameter('to', i) as string,
							message: this.getNodeParameter('message', i) as string,
							...extra,
						};
					} else if (operation === 'getStatus') {
						method = 'GET';
						// Only SMSTunnel's own id format goes into the path.
						const messageId = checkId(this.getNodeParameter('messageId', i));
						if (!messageId) {
							throw new NodeOperationError(this.getNode(), 'The Message ID is not an ID from SMSTunnel', {
								itemIndex: i,
								description:
									'Use the messageId that a Send or Send 2FA Code returned: 24 characters, digits and the letters a to f, such as 6735a0c4e1d9e1b7b54cf994.',
							});
						}
						endpoint = `/api/v1/sms/status/${encodeURIComponent(messageId)}`;
					} else if (operation === 'getReceived') {
						method = 'GET';
						endpoint = '/api/v1/sms/received';
					}
				} else if (resource === 'account' && operation === 'getUsage') {
					method = 'GET';
					endpoint = '/api/v1/account/usage';
				} else if (resource === 'device' && operation === 'getAll') {
					method = 'GET';
					endpoint = '/api/v1/devices';
				} else if (resource === 'scheduledText') {
					method = 'GET';
					if (operation === 'getAll') {
						endpoint = '/api/v1/sms/scheduled';
						qs = {
							scope: this.getNodeParameter('scope', i, 'waiting') as string,
							page: this.getNodeParameter('page', i, 1) as number,
							limit: this.getNodeParameter('limit', i, 50) as number,
						};
					} else if (operation === 'get' || operation === 'cancel') {
						const given = String(this.getNodeParameter('scheduledId', i, '') ?? '').trim();
						if (!given) {
							throw new NodeOperationError(
								this.getNode(),
								'The Scheduled Text ID is empty: use the scheduledId that Send with Send At returned.',
								{ itemIndex: i },
							);
						}
						// Only SMSTunnel's own id format goes into the path.
						const scheduledId = checkId(given);
						if (!scheduledId) {
							throw new NodeOperationError(this.getNode(), 'The Scheduled Text ID is not an ID from SMSTunnel', {
								itemIndex: i,
								description:
									'Use the scheduledId that Send with Send At returned: 24 characters, digits and the letters a to f, such as 6735a0c4e1d9e1b7b54cf994.',
							});
						}
						endpoint = `/api/v1/sms/scheduled/${encodeURIComponent(scheduledId)}`;
						if (operation === 'cancel') method = 'DELETE';
					}
				}

				if (!endpoint) {
					throw new NodeOperationError(
						this.getNode(),
						`The operation "${operation}" is not supported for resource "${resource}"`,
						{ itemIndex: i },
					);
				}

				const options: IHttpRequestOptions = {
					method,
					url: `${baseUrl}${endpoint}`,
					json: true,
					...(body !== undefined ? { body } : {}),
					...(qs !== undefined ? { qs } : {}),
				};

				const response = waitForLimit
					? await requestWaitingForLimit(this, options, i)
					: await this.helpers.httpRequestWithAuthentication.call(this, 'smsTunnelApi', options);

				returnData.push({
					json: response as IDataObject,
					pairedItem: { item: i },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: errorJson(error),
						pairedItem: { item: i },
					});
					continue;
				}
				// The node's own checks stay as they are; anything else becomes a NodeApiError (one that already
				// is comes back unchanged).
				throw error instanceof NodeOperationError
					? error
					: new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
