import { describe, expect, it } from 'vitest';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import {
	buildTranscriptionJsonBody,
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

describe('buildTranscriptionJsonBody', () => {
	it('base64-encodes the audio under input_audio with its format inferred from the filename', () => {
		const audio = new Uint8Array([0, 1, 2, 255]).buffer;
		const request = buildTranscriptionJsonBody({
			audio,
			fileName: 'recording.wav',
			contentType: 'audio/wav',
			model: 'openai/whisper-1',
			language: 'en',
		});
		expect(request.contentType).toBe('application/json');
		const payload = JSON.parse(request.body) as Record<string, unknown>;
		expect(payload).toMatchObject({
			model: 'openai/whisper-1',
			language: 'en',
			response_format: 'json',
			input_audio: {
				data: Buffer.from(audio).toString('base64'),
				format: 'wav',
			},
		});
	});

	it('omits empty optional fields', () => {
		const request = buildTranscriptionJsonBody({
			audio: new ArrayBuffer(0),
			fileName: 'voice.mp3',
			contentType: 'audio/mpeg',
			model: '',
		});
		const payload = JSON.parse(request.body) as Record<string, unknown>;
		expect(payload).not.toHaveProperty('model');
		expect(payload).not.toHaveProperty('language');
		expect((payload.input_audio as { format: string }).format).toBe('mp3');
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

	it('includes the response in the malformed-JSON error', async () => {
		const provider = new OpenAiTranscriptionProvider(async () =>
			response(200, { error: { message: 'upstream exploded' } }),
		);
		await expect(
			provider.transcribe('http://127.0.0.1:8001/v1', {
				audio: new ArrayBuffer(0),
				fileName: 'voice.wav',
				contentType: 'audio/wav',
				model: '',
			}),
		).rejects.toThrow(/without a text field.*upstream exploded/i);
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

	it('reports a non-JSON gateway error page without throwing a parse error', async () => {
		const html = '<html><body><h1>502 Bad Gateway</h1></body></html>';
		const provider = new OpenAiTranscriptionProvider(async () => ({
			status: 502,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
			get json(): unknown {
				throw new SyntaxError('Unexpected token <');
			},
			text: html,
		}));
		await expect(
			provider.transcribe('http://127.0.0.1:8001/v1', {
				audio: new ArrayBuffer(0),
				fileName: 'voice.wav',
				contentType: 'audio/wav',
				model: '',
			}),
		).rejects.toThrow(/HTTP 502 \(502 Bad Gateway\)/);
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

	it('sends a base64 JSON body when requestFormat is json-base64', async () => {
		let request: RequestUrlParam | undefined;
		const provider = new OpenAiTranscriptionProvider(async (nextRequest) => {
			request = nextRequest;
			return response(200, { text: 'Hello.' });
		});
		await provider.transcribe('https://openrouter.ai/api/v1', {
			audio: new Uint8Array([9, 8, 7]).buffer,
			fileName: 'voice.wav',
			contentType: 'audio/wav',
			model: 'openai/whisper-1',
			requestFormat: 'json-base64',
		});
		expect(request?.contentType).toBe('application/json');
		expect(typeof request?.body).toBe('string');
		const payload = JSON.parse(request?.body as string) as Record<string, unknown>;
		expect(payload).toMatchObject({
			model: 'openai/whisper-1',
			input_audio: { format: 'wav' },
		});
	});
});
