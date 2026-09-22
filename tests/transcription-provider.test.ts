import { describe, expect, it } from 'vitest';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import {
	buildTranscriptionMultipart,
	OpenAiTranscriptionProvider,
} from '../src/providers/openai-transcription';

function response(status: number, json: unknown): RequestUrlResponse {
	return {
		status,
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
		json,
		text: JSON.stringify(json),
	};
}

describe('buildTranscriptionMultipart', () => {
	it('builds the vLLM transcription fields and preserves audio bytes', () => {
		const audio = new Uint8Array([0, 1, 2, 255]).buffer;
		const multipart = buildTranscriptionMultipart(
			{
				audio,
				fileName: 'recording.wav',
				contentType: 'audio/wav',
				model: 'Qwen/Qwen3-ASR-1.7B',
				timestampGranularities: ['segment'],
			},
			'test-boundary',
		);
		const body = new Uint8Array(multipart.body);
		const text = new TextDecoder().decode(body);
		expect(multipart.contentType).toContain('boundary=test-boundary');
		expect(text).toContain('name="file"; filename="recording.wav"');
		expect(text).toContain('Qwen/Qwen3-ASR-1.7B');
		expect(text).toContain('name="timestamp_granularities[]"');
		expect(body).toContain(255);
		expect(text).toContain('name="response_format"\r\n\r\njson');
	});
});

describe('OpenAiTranscriptionProvider', () => {
	it('normalizes a verbose transcription response', async () => {
		let request: RequestUrlParam | undefined;
		const provider = new OpenAiTranscriptionProvider(async (nextRequest) => {
			request = nextRequest;
			return response(200, {
				text: 'Hello Samantha.',
				language: 'en',
				duration: 2.5,
				segments: [{ start: 0, end: 2.5, text: 'Hello Samantha.' }],
			});
		});
		const result = await provider.transcribe('http://127.0.0.1:8001/v1/', {
			audio: new Uint8Array([1]).buffer,
			fileName: 'voice.wav',
			contentType: 'audio/wav',
			model: 'Qwen/Qwen3-ASR-1.7B',
		});
		expect(request?.url).toBe(
			'http://127.0.0.1:8001/v1/audio/transcriptions',
		);
		expect(result.segments[0]).toMatchObject({
			id: 'seg-0001',
			start: 0,
			end: 2.5,
		});
	});

	it('rejects malformed provider output', async () => {
		const provider = new OpenAiTranscriptionProvider(async () =>
			response(200, { unexpected: true }),
		);
		await expect(
			provider.transcribe('http://127.0.0.1:8001/v1', {
				audio: new ArrayBuffer(0),
				fileName: 'voice.wav',
				contentType: 'audio/wav',
				model: '',
			}),
		).rejects.toThrow(/malformed/i);
	});

	it('surfaces the provider error message', async () => {
		const provider = new OpenAiTranscriptionProvider(async () =>
			response(400, {
				error: { message: 'Please install vllm[audio] for audio support' },
			}),
		);
		await expect(
			provider.transcribe('http://127.0.0.1:8001/v1', {
				audio: new ArrayBuffer(0),
				fileName: 'voice.wav',
				contentType: 'audio/wav',
				model: '',
			}),
		).rejects.toThrow(/vllm\[audio\]/i);
	});

	it('adds a bearer token when an API key is supplied', async () => {
		let request: RequestUrlParam | undefined;
		const provider = new OpenAiTranscriptionProvider(async (nextRequest) => {
			request = nextRequest;
			return response(200, { text: 'Hello.' });
		});
		await provider.transcribe('http://127.0.0.1:8001/v1', {
			audio: new ArrayBuffer(0),
			fileName: 'voice.wav',
			contentType: 'audio/wav',
			model: '',
			apiKey: 'secret-token',
		});
		expect(request?.headers).toEqual({ Authorization: 'Bearer secret-token' });
	});
});
