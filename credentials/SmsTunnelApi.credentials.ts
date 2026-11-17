import type {
	IAuthenticate,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

import { checkBaseUrl, isUnderBase, requestTarget } from '../nodes/SmsTunnel/GenericFunctions';

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
	 * Adds the key as the X-API-Key header, and only to a request for the Base URL (checked as the node checks it):
	 * the node, the Test of these credentials and an HTTP Request node that uses them all come through here. Redirects
	 * are not followed: the key would go along to wherever they point.
	 */
	authenticate: IAuthenticate = async (credentials, requestOptions) => {
		const checked = checkBaseUrl(credentials.baseUrl);
		if (!checked.ok) throw new Error(`${checked.message}. ${checked.description}`);
		if (!isUnderBase(requestTarget(requestOptions), checked.base)) {
			throw new Error(`The SMSTunnel API key is only sent to the Base URL of its credentials (${checked.base}).`);
		}
		return {
			...requestOptions,
			disableFollowRedirect: true,
			headers: { ...requestOptions.headers, 'X-API-Key': String(credentials.apiKey ?? '') },
		};
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{($credentials.baseUrl || "https://smstunnel.io").trim().replace(new RegExp("/+$"), "")}}',
			url: '/api/v1/account/usage',
			method: 'GET',
		},
	};
}
