import { describe, expect, it } from 'vitest';
import type { RecordingSource } from '../src/model';
import {
	compileFilenameTimestampRegex,
	DEFAULT_DJI_FILENAME_TIMESTAMP_REGEX,
	parseFilenameTimestamp,
	resolveRecordingTimestamp,
} from '../src/ingest/recording-timestamp';

const source: RecordingSource = {
	id: 'dji',
	name: 'DJI microphone',
	path: '/recordings',
	recursive: true,
	extensions: ['.wav'],
	minimumAgeSeconds: 10,
	timestampSource: 'filename',
	filenameTimestampRegex: DEFAULT_DJI_FILENAME_TIMESTAMP_REGEX,
	timestampOffsetHours: 0,
};

describe('recording timestamps', () => {
	it('parses the local recording time from a DJI filename', () => {
		const timestamp = parseFilenameTimestamp(
			'TX01_MIC002_20260921_190443_orig.wav',
			compileFilenameTimestampRegex(DEFAULT_DJI_FILENAME_TIMESTAMP_REGEX),
		);
		expect(timestamp).not.toBeNull();
		const date = new Date(timestamp ?? 0);
		expect([
			date.getFullYear(),
			date.getMonth() + 1,
			date.getDate(),
			date.getHours(),
			date.getMinutes(),
			date.getSeconds(),
		]).toEqual([2026, 9, 21, 19, 4, 43]);
	});

	it('supports custom named-group ordering and rejects invalid dates', () => {
		const regex = compileFilenameTimestampRegex(
			'^(?<day>\\d{2})-(?<month>\\d{2})-(?<year>\\d{4})_(?<hour>\\d{2})-(?<minute>\\d{2})-(?<second>\\d{2})\\.wav$',
		);
		expect(parseFilenameTimestamp('21-09-2026_19-04-43.wav', regex)).not.toBeNull();
		expect(parseFilenameTimestamp('31-02-2026_19-04-43.wav', regex)).toBeNull();
	});

	it('applies an hour offset to either timestamp source', () => {
		const modifiedAtMs = Date.UTC(2026, 8, 21, 19, 4, 56);
		expect(
			resolveRecordingTimestamp(
				{
					...source,
					timestampSource: 'filesystem',
					timestampOffsetHours: -9,
				},
				'anything.wav',
				modifiedAtMs,
			),
		).toBe(modifiedAtMs - 9 * 60 * 60 * 1000);
	});
});
