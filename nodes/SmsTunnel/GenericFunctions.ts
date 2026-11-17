import type { IHttpRequestOptions } from 'n8n-workflow';

/** SMSTunnel's own server: the Base URL when the credentials leave it empty. */
export const DEFAULT_BASE_URL = 'https://smstunnel.io';

/** What is wrong with a value, in n8n's two parts: what happened, and how to fix it. */
export type Refusal = { message: string; description: string };

/**
 * The Base URL of the credentials as the node calls it: the origin and the path, without a trailing slash. The API
 * key is sent to it, so only https:// is taken; http:// only for a server on this computer (localhost, 127.0.0.1).
 * A user name or password, a query or a fragment are refused. The address itself is never repeated in the refusal:
 * it may carry a password.
 */
export function checkBaseUrl(value: unknown): { ok: true; base: string } | ({ ok: false } & Refusal) {
	const text = value === undefined || value === null ? '' : String(value).trim();
	if (!text) return { ok: true, base: DEFAULT_BASE_URL };
	const fix = `Use ${DEFAULT_BASE_URL}, or the https:// address of your own SMSTunnel server.`;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return { ok: false, message: 'The Base URL in the SMSTunnel credentials is not a web address', description: fix };
	}
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
		return {
			ok: false,
			message: 'The Base URL in the SMSTunnel credentials must start with https://',
			description: `The API key is sent to this address. ${fix} http:// is only for a server on this computer (http://localhost or http://127.0.0.1).`,
		};
	}
	if (url.username || url.password) {
		return {
			ok: false,
			message: 'The Base URL in the SMSTunnel credentials must not contain a user name or password',
			description: `${fix} The key goes in API Key.`,
		};
	}
	if (url.search || url.hash || /[?#]/.test(text)) {
		return {
			ok: false,
			message: 'The Base URL in the SMSTunnel credentials must not have a query (?…) or a fragment (#…)',
			description: fix,
		};
	}
	return { ok: true, base: url.origin + url.pathname.replace(/\/+$/, '') };
}

/**
 * The address a request goes to, as axios builds it: `url` when it is absolute (protocol-relative `//host` counts),
 * otherwise `baseURL` and `url` joined with one slash.
 */
export function requestTarget(options: Pick<IHttpRequestOptions, 'url' | 'baseURL'>): string {
	const url = String(options.url ?? '');
	if (!options.baseURL || /^([a-z][a-z\d+\-.]*:)?\/\//i.test(url)) return url;
	return `${String(options.baseURL).replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

/**
 * Every address a request names: its `url`, and its `uri` for the older request format (n8n's HTTP Request node
 * signs requests that way), each joined with `baseURL`. A request that names none gives [''], which no Base URL
 * contains.
 */
export function requestTargets(options: { url?: unknown; uri?: unknown; baseURL?: unknown }): string[] {
	const named = [options.url, options.uri].filter((value) => value !== undefined && value !== null && value !== '');
	if (named.length === 0) return [''];
	return named.map((value) =>
		requestTarget({ url: String(value), baseURL: options.baseURL === undefined ? undefined : String(options.baseURL) }),
	);
}

/** Whether `target` is `base` or below it: the same origin, inside its path, without a user name or password. */
export function isUnderBase(target: string, base: string): boolean {
	let url: URL;
	let root: URL;
	try {
		url = new URL(target);
		root = new URL(base);
	} catch {
		return false;
	}
	if (url.origin !== root.origin || url.username || url.password) return false;
	const path = root.pathname.replace(/\/+$/, '');
	return path === '' || url.pathname === path || url.pathname.startsWith(`${path}/`);
}

/**
 * All the waiting one run of the node may do for SMSTunnel's per-minute limit, in ms, shared by every item and every
 * number: a wait that would go past it doesn't happen, and the 429 is the answer.
 */
export const WAIT_BUDGET_MS = 60_000;

/**
 * How long a 429 says to wait before asking again, in ms (Retry-After, in seconds or as an HTTP date; a date in the
 * past is 0), or undefined when it doesn't say. SMSTunnel's per-minute limits answer with Retry-After, and then
 * nothing was sent; the plan's daily limit answers without it.
 */
export function retryAfterMs(headers: unknown, now = Date.now()): number | undefined {
	if (!headers || typeof headers !== 'object') return undefined;
	const entry = Object.entries(headers as Record<string, unknown>).find(([name]) => name.toLowerCase() === 'retry-after');
	const raw = Array.isArray(entry?.[1]) ? entry?.[1][0] : entry?.[1];
	if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
	const text = String(raw).trim();
	const seconds = /^\d+(\.\d+)?$/.test(text) ? Number(text) : (Date.parse(text) - now) / 1000;
	if (!Number.isFinite(seconds)) return undefined;
	return Math.max(seconds, 0) * 1000;
}

/** SMSTunnel's ids (messageId, scheduledId) are MongoDB ObjectIds: 24 hexadecimal characters. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * An id that goes into a URL path, trimmed, or undefined when it is not one of SMSTunnel's ids. Only the real format
 * gets through, so nothing such as `..` or `/` can change the path.
 */
export function checkId(value: unknown): string | undefined {
	const text = value === undefined || value === null ? '' : String(value).trim();
	return OBJECT_ID.test(text) ? text : undefined;
}
