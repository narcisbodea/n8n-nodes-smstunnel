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
