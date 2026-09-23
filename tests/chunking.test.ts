import { describe, expect, it } from 'vitest';
import {
	planChunkSeconds,
	STT_MAX_CHUNK_BYTES,
	STT_MAX_CHUNK_SECONDS,
} from '../src/audio/chunking';

describe('planChunkSeconds', () => {
	it('does not split a recording within both limits', () => {
		expect(planChunkSeconds(5 * 1024 * 1024, 120)).toBeNull();
	});

	it('splits uncompressed audio by size', () => {
		// 66.6 MB over 484 s is the 48 kHz 24-bit mono DJI recording.
		const seconds = planChunkSeconds(69_807_976, 484.55);
		expect(seconds).toBe(145);
		expect((69_807_976 / 484.55) * (seconds ?? 0)).toBeLessThanOrEqual(
			STT_MAX_CHUNK_BYTES,
		);
	});

	it('splits small but long compressed audio by time', () => {
		expect(planChunkSeconds(10 * 1024 * 1024, 3600)).toBe(STT_MAX_CHUNK_SECONDS);
	});

	it('refuses to guess for an oversized file with unknown duration', () => {
		expect(() => planChunkSeconds(STT_MAX_CHUNK_BYTES + 1, null)).toThrow(
			/duration/i,
		);
		expect(planChunkSeconds(1024, null)).toBeNull();
	});
});
