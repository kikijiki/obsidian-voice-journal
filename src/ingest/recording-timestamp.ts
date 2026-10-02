import type { RecordingSource } from '../model';

const HOUR_MS = 60 * 60 * 1000;
const REQUIRED_GROUPS = [
	'year',
	'month',
	'day',
	'hour',
	'minute',
	'second',
] as const;

export const DEFAULT_DJI_FILENAME_TIMESTAMP_REGEX =
	'^TX\\d+_MIC\\d+_(?<year>\\d{4})(?<month>\\d{2})(?<day>\\d{2})_(?<hour>\\d{2})(?<minute>\\d{2})(?<second>\\d{2})(?:_[^.]+)?\\.[^.]+$';

export function compileFilenameTimestampRegex(pattern: string): RegExp {
	try {
		return new RegExp(pattern, 'iu');
	} catch (error) {
		throw new Error(
			`Filename timestamp regex is invalid: ${error instanceof Error ? error.message : 'unknown regular-expression error'}`,
		);
	}
}

export function parseFilenameTimestamp(
	fileName: string,
	regex: RegExp,
): number | null {
	const groups = regex.exec(fileName)?.groups;
	if (groups === undefined) {
		return null;
	}
	const values = Object.fromEntries(
		REQUIRED_GROUPS.map((name) => [name, Number.parseInt(groups[name] ?? '', 10)]),
	) as Record<(typeof REQUIRED_GROUPS)[number], number>;
	if (REQUIRED_GROUPS.some((name) => !Number.isInteger(values[name]))) {
		return null;
	}

	// Validate the fields in UTC, where every wall-clock time exists, so a
	// time inside a daylight-saving gap is not mistaken for an invalid date.
	const utc = new Date(
		Date.UTC(
			values.year,
			values.month - 1,
			values.day,
			values.hour,
			values.minute,
			values.second,
		),
	);
	if (
		utc.getUTCFullYear() !== values.year ||
		utc.getUTCMonth() !== values.month - 1 ||
		utc.getUTCDate() !== values.day ||
		utc.getUTCHours() !== values.hour ||
		utc.getUTCMinutes() !== values.minute ||
		utc.getUTCSeconds() !== values.second
	) {
		return null;
	}
	// Local interpretation. A time skipped by a spring-forward gap resolves to
	// the equivalent instant just after it (02:30 becomes 03:30); a repeated
	// autumn hour resolves to its first occurrence.
	const date = new Date(0);
	date.setFullYear(values.year, values.month - 1, values.day);
	date.setHours(values.hour, values.minute, values.second, 0);
	return date.valueOf();
}

export function resolveRecordingTimestamp(
	source: RecordingSource,
	fileName: string,
	modifiedAtMs: number,
	filenameRegex?: RegExp,
): number | null {
	const baseTimestamp =
		source.timestampSource === 'filesystem'
			? modifiedAtMs
			: parseFilenameTimestamp(
					fileName,
					filenameRegex ??
						compileFilenameTimestampRegex(source.filenameTimestampRegex),
				);
	return baseTimestamp === null
		? null
		: baseTimestamp + source.timestampOffsetHours * HOUR_MS;
}

export function formatLocalTimestamp(timestampMs: number): string {
	const date = new Date(timestampMs);
	const pad = (value: number, width = 2): string =>
		value.toString().padStart(width, '0');
	const offsetMinutes = -date.getTimezoneOffset();
	const offsetSign = offsetMinutes >= 0 ? '+' : '-';
	const absoluteOffset = Math.abs(offsetMinutes);
	return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${offsetSign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}
