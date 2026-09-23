// Per-request limits taken from OpenRouter's speech-to-text guidance and used
// for every provider, so local servers with typical 25 MB upload limits and
// request timeouts stay within bounds too. The size limit keeps a chunk under
// OpenRouter's 25 MB multipart cap (and its base64 JSON body well under the
// ~50 MB observed cap); the time limit keeps a chunk within the ~60 s upstream
// processing timeout.
export const STT_MAX_CHUNK_BYTES = 20 * 1024 * 1024;
export const STT_MAX_CHUNK_SECONDS = 300;

const MIN_CHUNK_SECONDS = 10;

export function planChunkSeconds(
	sizeBytes: number,
	durationSeconds: number | null,
): number | null {
	if (durationSeconds === null || durationSeconds <= 0) {
		if (sizeBytes <= STT_MAX_CHUNK_BYTES) {
			return null;
		}
		throw new Error(
			'Could not determine the recording duration, so it cannot be split to fit the speech-to-text upload limit.',
		);
	}
	if (sizeBytes <= STT_MAX_CHUNK_BYTES && durationSeconds <= STT_MAX_CHUNK_SECONDS) {
		return null;
	}
	const bytesPerSecond = sizeBytes / durationSeconds;
	const secondsBySize = Math.floor(STT_MAX_CHUNK_BYTES / bytesPerSecond);
	return Math.max(
		MIN_CHUNK_SECONDS,
		Math.min(STT_MAX_CHUNK_SECONDS, secondsBySize),
	);
}
