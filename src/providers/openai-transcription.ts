import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { normalizeApiBaseUrl, buildAuthHeaders } from './openai-compatible';
import { withTimeout } from './timeout';

export type TranscriptionRequestUrl = (
	request: RequestUrlParam,
) => Promise<RequestUrlResponse>;

export type TranscriptionRequestFormat = 'multipart' | 'json-base64';

export interface TranscriptionInput {
	audio: ArrayBuffer;
	fileName: string;
	contentType: string;
	model: string;
	apiKey?: string;
	language?: string;
	prompt?: string;
	timestampGranularities?: Array<'word' | 'segment'>;
	requestFormat?: TranscriptionRequestFormat;
}

export interface TranscriptSegment {
	id: string;
	start?: number;
	end?: number;
	text: string;
}

export interface TranscriptionResult {
	text: string;
	language?: string;
	duration?: number;
	segments: TranscriptSegment[];
	rawResponse: unknown;
}

interface MultipartBody {
	contentType: string;
	body: ArrayBuffer;
}

interface JsonBody {
	contentType: string;
	body: string;
}

function safeFileName(fileName: string): string {
	return fileName.replace(/["\r\n]/g, '_');
}

function audioFormatFromFileName(fileName: string): string {
	return /\.([a-z0-9]+)$/iu.exec(fileName)?.[1]?.toLowerCase() ?? 'wav';
}

function encode(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function joinBytes(parts: Uint8Array[]): ArrayBuffer {
	const length = parts.reduce((total, part) => total + part.byteLength, 0);
	const joined = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.byteLength;
	}
	return joined.buffer;
}

export function buildTranscriptionMultipart(
	input: TranscriptionInput,
	boundary = `----VoiceJournal${crypto.randomUUID()}`,
): MultipartBody {
	const parts: Uint8Array[] = [];
	const addTextField = (name: string, value: string): void => {
		parts.push(
			encode(
				`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
			),
		);
	};

	parts.push(
		encode(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFileName(input.fileName)}"\r\nContent-Type: ${input.contentType}\r\n\r\n`,
		),
		new Uint8Array(input.audio),
		encode('\r\n'),
	);
	if (input.model !== '') {
		addTextField('model', input.model);
	}
	if (input.language !== undefined && input.language !== '') {
		addTextField('language', input.language);
	}
	if (input.prompt !== undefined && input.prompt !== '') {
		addTextField('prompt', input.prompt);
	}
	addTextField('response_format', 'json');
	for (const granularity of input.timestampGranularities ?? []) {
		addTextField('timestamp_granularities[]', granularity);
	}
	parts.push(encode(`--${boundary}--\r\n`));

	return {
		contentType: `multipart/form-data; boundary=${boundary}`,
		body: joinBytes(parts),
	};
}

export function buildTranscriptionJsonBody(input: TranscriptionInput): JsonBody {
	const payload: Record<string, unknown> = {
		input_audio: {
			data: Buffer.from(input.audio).toString('base64'),
			format: audioFormatFromFileName(input.fileName),
		},
		response_format: 'json',
	};
	if (input.model !== '') {
		payload.model = input.model;
	}
	if (input.language !== undefined && input.language !== '') {
		payload.language = input.language;
	}
	if (input.prompt !== undefined && input.prompt !== '') {
		payload.prompt = input.prompt;
	}
	if (input.timestampGranularities !== undefined && input.timestampGranularities.length > 0) {
		payload.timestamp_granularities = input.timestampGranularities;
	}
	return {
		contentType: 'application/json',
		body: JSON.stringify(payload),
	};
}

function transcriptionError(response: RequestUrlResponse): string {
	try {
		const body = response.json as unknown;
		if (isRecord(body)) {
			const error = body.error;
			if (isRecord(error) && typeof error.message === 'string') {
				return error.message;
			}
		}
	} catch {
		// Non-JSON error pages (for example a gateway 502) fall through below.
	}
	const detail = response.text.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim();
	return detail === ''
		? `HTTP ${response.status.toString()}`
		: `HTTP ${response.status.toString()} (${snippet(detail)})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function snippet(value: string): string {
	return value.length > 300 ? `${value.slice(0, 300)}…` : value;
}

function parseTranscriptionResponse(value: unknown): TranscriptionResult {
	if (!isRecord(value) || typeof value.text !== 'string') {
		throw new Error(
			`The transcription provider returned malformed JSON without a text field: ${snippet(JSON.stringify(value) ?? String(value))}`,
		);
	}
	const rawSegments = Array.isArray(value.segments) ? value.segments : [];
	const segments = rawSegments.flatMap((segment, index): TranscriptSegment[] => {
		if (!isRecord(segment) || typeof segment.text !== 'string') {
			return [];
		}
		return [
			{
				id: `seg-${(index + 1).toString().padStart(4, '0')}`,
				start: optionalNumber(segment.start),
				end: optionalNumber(segment.end),
				text: segment.text,
			},
		];
	});
	return {
		text: value.text,
		language: typeof value.language === 'string' ? value.language : undefined,
		duration: optionalNumber(value.duration),
		segments,
		rawResponse: value,
	};
}

export class OpenAiTranscriptionProvider {
	constructor(
		private readonly requester: TranscriptionRequestUrl,
		private readonly timeoutMs = 600_000,
	) {}

	async transcribe(
		baseUrl: string,
		input: TranscriptionInput,
	): Promise<TranscriptionResult> {
		const request =
			input.requestFormat === 'json-base64'
				? buildTranscriptionJsonBody(input)
				: buildTranscriptionMultipart(input);
		const headers = buildAuthHeaders(input.apiKey ?? '');
		const response = await withTimeout(
			this.requester({
				url: `${normalizeApiBaseUrl(baseUrl)}/audio/transcriptions`,
				method: 'POST',
				contentType: request.contentType,
				body: request.body,
				throw: false,
				...(headers === undefined ? {} : { headers }),
			}),
			this.timeoutMs,
			'Transcription request',
		);
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Transcription failed: ${transcriptionError(response)}.`);
		}
		let parsed: unknown;
		try {
			parsed = response.json as unknown;
		} catch {
			throw new Error(
				`The transcription provider returned malformed JSON (HTTP ${response.status.toString()}): ${snippet(response.text)}`,
			);
		}
		return parseTranscriptionResponse(parsed);
	}
}
