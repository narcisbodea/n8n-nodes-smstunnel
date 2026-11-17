import type {
	IAuthenticate,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

import { checkBaseUrl, isUnderBase, requestTargets } from '../nodes/SmsTunnel/GenericFunctions';

/** The older request format some nodes sign through (n8n's HTTP Request node): `uri`, and its redirect switches. */
type AnyRequestOptions = IHttpRequestOptions & { uri?: string; followRedirect?: boolean; followAllRedirects?: boolean };

export class SmsTunnelApi implements ICredentialType {
	name = 'smsTunnelApi';

	displayName = 'SMSTunnel API';

	// The node's icon, which reads well on both themes. The path is relative to dist/credentials/.
	icon: Icon = {
		light: 'file:../nodes/SmsTunnel/smstunnel.svg',
		dark: 'file:../nodes/SmsTunnel/smstunnel.svg',
	};

	// The credentials' "docs" link in n8n: the integration page, which explains this API key and Base URL.
	// (https://smstunnel.io/docs/api, used up to 1.0.3, is a 404.)
	documentationUrl = 'https://smstunnel.io/integrations/n8n/';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'API key generated in your SMSTunnel dashboard. It needs the "sms:send" permission to send messages and "sms:read" to read statuses.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://smstunnel.io',
			required: true,
			description:
				'Your API key is sent to this address. Keep https://smstunnel.io unless you run your own SMSTunnel server, whose address must start with https://.',
		},
	];

	/**
	 * Adds the key as the X-API-Key header, and only to a request whose every address (url, and uri in the older
	 * format) is the Base URL or below it, checked as the node checks it: the node, the Test of these credentials and an
	 * HTTP Request node that uses them all come through here. Redirects are not followed, in either format: n8n drops
	 * Authorization and cookies on a redirect to another host, but X-API-Key would go along.
	 */
	authenticate: IAuthenticate = async (credentials, requestOptions) => {
		const checked = checkBaseUrl(credentials.baseUrl);
		if (!checked.ok) throw new Error(`${checked.message}. ${checked.description}`);
		const request = requestOptions as AnyRequestOptions;
		if (!requestTargets(request).every((target) => isUnderBase(target, checked.base))) {
			throw new Error(`The SMSTunnel API key is only sent to the Base URL of its credentials (${checked.base}).`);
		}
		const signed: AnyRequestOptions = {
			...request,
			disableFollowRedirect: true,
			followRedirect: false,
			followAllRedirects: false,
			headers: { ...request.headers, 'X-API-Key': String(credentials.apiKey ?? '') },
		};
		return signed;
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{($credentials.baseUrl || "https://smstunnel.io").trim().replace(new RegExp("/+$"), "")}}',
			url: '/api/v1/account/usage',
			method: 'GET',
		},
	};
}
