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

	const date = new Date(0);
	date.setFullYear(values.year, values.month - 1, values.day);
	date.setHours(values.hour, values.minute, values.second, 0);
	if (
		date.getFullYear() !== values.year ||
		date.getMonth() !== values.month - 1 ||
		date.getDate() !== values.day ||
		date.getHours() !== values.hour ||
		date.getMinutes() !== values.minute ||
		date.getSeconds() !== values.second
	) {
		return null;
	}
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
