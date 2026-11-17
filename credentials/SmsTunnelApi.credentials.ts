import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class SmsTunnelApi implements ICredentialType {
	name = 'smsTunnelApi';

	displayName = 'SMSTunnel API';

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
				'Base URL of the SMSTunnel server. Change this only if you run a self-hosted instance.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-API-Key': '={{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(new RegExp("/$"), "")}}',
			url: '/api/v1/account/usage',
			method: 'GET',
		},
	};
}
