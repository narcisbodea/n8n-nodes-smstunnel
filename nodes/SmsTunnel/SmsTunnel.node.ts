import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

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

export class SmsTunnel implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SMSTunnel',
		name: 'smsTunnel',
		// One icon that reads well on both themes (white bubble on a blue tile).
		icon: { light: 'file:smstunnel.svg', dark: 'file:smstunnel.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
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
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['message'] } },
				options: [
					{
						name: 'Get Received',
						value: 'getReceived',
						description: 'Get received SMS synced from your phone (only if sync is on in the app)',
						action: 'Get received messages',
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
					},
					{
						// Display text only. The value stays 'sendBulk' because saved workflows store it.
						name: 'Send to Several Recipients',
						value: 'sendBulk',
						description: 'Send the same SMS to up to 100 recipients in one request',
						action: 'Send an SMS to several recipients',
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

			// ─────────────────────────── message: sendBulk ───────────────────────────
			{
				displayName: 'To',
				name: 'toBulk',
				type: 'string',
				required: true,
				default: '',
				placeholder: '+40712345678, +40787654321',
				description:
					'Recipient phone numbers, separated by comma, semicolon or newline. Maximum 100 per request.',
				displayOptions: { show: { resource: ['message'], operation: ['sendBulk'] } },
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
		const baseUrl = String(credentials.baseUrl ?? 'https://smstunnel.io').replace(/\/+$/, '');

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

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
								`Too many recipients (${recipients.length}). The API accepts at most 100 per request — split them into several batches.`,
								{ itemIndex: i },
							);
						}

						endpoint = '/api/v1/sms/send-bulk';
						body = {
							to: recipients,
							message: this.getNodeParameter('message', i) as string,
							...extra,
						};
					} else if (operation === 'send2fa') {
						endpoint = '/api/v1/sms/send-2fa';
						body = {
							to: this.getNodeParameter('to', i) as string,
							message: this.getNodeParameter('message', i) as string,
							...extra,
						};
					} else if (operation === 'getStatus') {
						method = 'GET';
						const messageId = this.getNodeParameter('messageId', i) as string;
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
						const scheduledId = String(this.getNodeParameter('scheduledId', i, '') ?? '').trim();
						if (!scheduledId) {
							throw new NodeOperationError(
								this.getNode(),
								'The Scheduled Text ID is empty: use the scheduledId that Send with Send At returned.',
								{ itemIndex: i },
							);
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

				const response = await this.helpers.httpRequestWithAuthentication.call(
					this,
					'smsTunnelApi',
					options,
				);

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
