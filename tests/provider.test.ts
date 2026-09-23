import { describe, expect, it } from 'vitest';
import type { RequestUrlResponse } from 'obsidian';
import {
	OpenAiCompatibleProvider,
	normalizeApiBaseUrl,
} from '../src/providers/openai-compatible';

function response(status: number, json: unknown): RequestUrlResponse {
	return {
		status,
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
		json,
		text: JSON.stringify(json),
	};
}

describe('normalizeApiBaseUrl', () => {
	it('normalizes trailing slashes', () => {
		expect(normalizeApiBaseUrl('http://127.0.0.1:8000/v1/')).toBe(
			'http://127.0.0.1:8000/v1',
		);
	});

	it('rejects embedded credentials', () => {
		expect(() =>
			normalizeApiBaseUrl('http://user:secret@127.0.0.1:8000/v1'),
		).toThrow(/credentials/i);
	});
});

describe('OpenAiCompatibleProvider', () => {
	it('returns model identifiers from /models', async () => {
		const provider = new OpenAiCompatibleProvider(async () =>
			response(200, { data: [{ id: 'example-model' }] }),
		);
		const health = await provider.checkHealth('http://127.0.0.1:8000/v1');
		expect(health.ok).toBe(true);
		expect(health.models).toEqual(['example-model']);
	});

	it('reports non-success responses without throwing', async () => {
		const provider = new OpenAiCompatibleProvider(async () =>
			response(503, {}),
		);
		const health = await provider.checkHealth('http://127.0.0.1:8000/v1');
		expect(health.ok).toBe(false);
		expect(health.error).toContain('503');
	});

	it('sends a bearer token only when an API key is configured', async () => {
		const headers: Array<Record<string, string> | undefined> = [];
		const provider = new OpenAiCompatibleProvider(async (request) => {
			headers.push(
				typeof request === 'string' ? undefined : request.headers,
			);
			return response(200, { data: [] });
		});
		await provider.checkHealth('http://127.0.0.1:8000/v1', 'secret-token');
		await provider.checkHealth('http://127.0.0.1:8000/v1');
		expect(headers[0]).toEqual({ Authorization: 'Bearer secret-token' });
		expect(headers[1]).toBeUndefined();
	});

	it('lists model identifiers, applying an optional query filter', async () => {
		const urls: string[] = [];
		const provider = new OpenAiCompatibleProvider(async (request) => {
			urls.push(typeof request === 'string' ? request : request.url);
			return response(200, {
				data: [{ id: 'openai/whisper-1' }, { id: 'not-a-model' }],
			});
		});
		const models = await provider.listModels(
			'http://127.0.0.1:8000/v1',
			'secret-token',
			{ output_modalities: 'transcription' },
		);
		expect(models).toEqual(['openai/whisper-1', 'not-a-model']);
		expect(urls[0]).toBe(
			'http://127.0.0.1:8000/v1/models?output_modalities=transcription',
		);
	});

	it('throws when model discovery receives a non-success response', async () => {
		const provider = new OpenAiCompatibleProvider(async () => response(401, {}));
		await expect(
			provider.listModels('http://127.0.0.1:8000/v1'),
		).rejects.toThrow(/401/);
	});
});
