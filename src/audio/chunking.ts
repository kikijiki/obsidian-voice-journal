// Per-request limits taken from OpenRouter's speech-to-text guidance and used
// for every provider, so local servers with typical 25 MB upload limits and
// request timeouts stay within bounds too. The size limit keeps a chunk under
// OpenRouter's 25 MB multipart cap (and its base64 JSON body well under the
// ~50 MB observed cap); the time limit keeps a chunk within the ~60 s upstream
// processing timeout.
export const STT_MAX_CHUNK_BYTES = 20 * 1024 * 1024;
export const STT_MAX_CHUNK_SECONDS = 300;

// Chunks are planned against a fraction of the byte limit: segments are cut
// on packet boundaries, variable-bitrate audio is denser in some stretches
// than the file average, and each chunk repeats the container header.
const CHUNK_SIZE_SAFETY_FACTOR = 0.9;
const MIN_CHUNK_SECONDS = 1;

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
	const secondsBySize = Math.floor(
		(STT_MAX_CHUNK_BYTES * CHUNK_SIZE_SAFETY_FACTOR) / bytesPerSecond,
	);
	// A floor must never override the size limit; only when even a single
	// second would not fit is splitting hopeless.
	if (secondsBySize < MIN_CHUNK_SECONDS) {
		throw new Error(
			'The recording bitrate is too high to split it into chunks that fit the speech-to-text upload limit.',
		);
	}
	return Math.min(STT_MAX_CHUNK_SECONDS, secondsBySize);
}
