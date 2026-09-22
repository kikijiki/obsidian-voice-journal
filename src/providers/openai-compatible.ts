import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import type { ProviderHealth } from '../model';
import { withTimeout } from './timeout';

export type RequestUrlLike = (
	request: RequestUrlParam | string,
) => Promise<RequestUrlResponse>;

interface ModelListResponse {
	data?: Array<{ id?: unknown }>;
}

export function normalizeApiBaseUrl(value: string): string {
	const url = new URL(value.trim());
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('Provider URL must use HTTP or HTTPS.');
	}
	if (url.username !== '' || url.password !== '') {
		throw new Error('Put credentials in authentication settings, not the URL.');
	}
	url.hash = '';
	url.search = '';
	url.pathname = url.pathname.replace(/\/+$/, '');
	return url.toString().replace(/\/$/, '');
}

function parseModelIds(value: unknown): string[] {
	if (typeof value !== 'object' || value === null) {
		return [];
	}
	const data = (value as ModelListResponse).data;
	if (!Array.isArray(data)) {
		return [];
	}
	return data.flatMap((model) =>
		typeof model.id === 'string' && model.id.trim() !== ''
			? [model.id]
			: [],
	);
}

export function buildAuthHeaders(apiKey: string): Record<string, string> | undefined {
	const trimmed = apiKey.trim();
	return trimmed === '' ? undefined : { Authorization: `Bearer ${trimmed}` };
}

export class OpenAiCompatibleProvider {
	constructor(
		private readonly requester: RequestUrlLike,
		private readonly timeoutMs = 15_000,
	) {}

	async checkHealth(baseUrl: string, apiKey = ''): Promise<ProviderHealth> {
		const startedAt = performance.now();
		let normalizedUrl = baseUrl.trim();
		try {
			normalizedUrl = normalizeApiBaseUrl(baseUrl);
			const headers = buildAuthHeaders(apiKey);
			const response = await withTimeout(
				this.requester({
					url: `${normalizedUrl}/models`,
					method: 'GET',
					throw: false,
					...(headers === undefined ? {} : { headers }),
				}),
				this.timeoutMs,
				'Provider health check',
			);
			if (response.status < 200 || response.status >= 300) {
				return {
					baseUrl: normalizedUrl,
					ok: false,
					latencyMs: Math.round(performance.now() - startedAt),
					models: [],
					error: `HTTP ${response.status} from /models.`,
				};
			}
			return {
				baseUrl: normalizedUrl,
				ok: true,
				latencyMs: Math.round(performance.now() - startedAt),
				models: parseModelIds(response.json),
			};
		} catch (error) {
			return {
				baseUrl: normalizedUrl,
				ok: false,
				latencyMs: Math.round(performance.now() - startedAt),
				models: [],
				error: error instanceof Error ? error.message : 'Unknown provider error.',
			};
		}
	}
}
