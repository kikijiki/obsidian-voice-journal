import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type {
	AudioCandidate,
	RecordingSource,
	ScanResult,
	SourceScanError,
	SourceScanWarning,
} from '../model';
import {
	compileFilenameTimestampRegex,
	resolveRecordingTimestamp,
} from './recording-timestamp';

function normalizeExtensions(extensions: string[]): Set<string> {
	return new Set(
		extensions.map((extension) => {
			const normalized = extension.trim().toLowerCase();
			return normalized.startsWith('.') ? normalized : `.${normalized}`;
		}),
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown filesystem error.';
}

export class SourceScanner {
	async scan(
		sources: RecordingSource[],
		maxEntries: number,
		nowMs = Date.now(),
	): Promise<ScanResult> {
		const candidates: AudioCandidate[] = [];
		const errors: SourceScanError[] = [];
		const warnings: SourceScanWarning[] = [];
		const budget = { visited: 0, limit: maxEntries, exhausted: false };

		for (const source of sources) {
			if (budget.exhausted) {
				break;
			}
			await this.scanSource(source, candidates, errors, warnings, budget, nowMs);
		}

		candidates.sort((left, right) => left.recordedAtMs - right.recordedAtMs);
		return { candidates, errors, warnings };
	}

	private async scanSource(
		source: RecordingSource,
		candidates: AudioCandidate[],
		errors: SourceScanError[],
		warnings: SourceScanWarning[],
		budget: { visited: number; limit: number; exhausted: boolean },
		nowMs: number,
	): Promise<void> {
		if (!isAbsolute(source.path)) {
			errors.push({
				sourceId: source.id,
				path: source.path,
				message: 'Recording source must be an absolute path.',
			});
			return;
		}

		const root = resolve(source.path);
		const extensions = normalizeExtensions(source.extensions);
		let filenameTimestampRegex: RegExp | undefined;
		if (source.timestampSource === 'filename') {
			try {
				filenameTimestampRegex = compileFilenameTimestampRegex(
					source.filenameTimestampRegex,
				);
			} catch (error) {
				errors.push({
					sourceId: source.id,
					path: source.path,
					message: errorMessage(error),
				});
				return;
			}
		}
		const visit = async (directory: string): Promise<void> => {
			let entries: Dirent[];
			try {
				entries = await readdir(directory, { withFileTypes: true });
			} catch (error) {
				errors.push({
					sourceId: source.id,
					path: directory,
					message: errorMessage(error),
				});
				return;
			}

			for (const entry of entries) {
				if (budget.visited >= budget.limit) {
					budget.exhausted = true;
					errors.push({
						sourceId: source.id,
						path: directory,
						message:
							'Scan entry limit reached; narrow the configured source or raise the limit.',
					});
					return;
				}
				budget.visited += 1;
				if (entry.isSymbolicLink()) {
					continue;
				}
				const absolutePath = resolve(directory, entry.name);
				if (entry.isDirectory()) {
					if (source.recursive) {
						await visit(absolutePath);
					}
					continue;
				}
				if (!entry.isFile() || !extensions.has(extname(entry.name).toLowerCase())) {
					continue;
				}

				try {
					const fileStat = await stat(absolutePath);
					const recordedAtMs = resolveRecordingTimestamp(
						source,
						entry.name,
						fileStat.mtimeMs,
						filenameTimestampRegex,
					);
					if (recordedAtMs === null) {
						errors.push({
							sourceId: source.id,
							path: absolutePath,
							message:
								'Filename does not match the configured timestamp regex and named date/time groups.',
						});
						continue;
					}
					const ageTimestampMs =
						source.timestampSource === 'filesystem'
							? recordedAtMs
							: fileStat.mtimeMs;
					const ageMs = nowMs - ageTimestampMs;
					if (ageMs < 0 && source.timestampSource === 'filesystem') {
						warnings.push({
							sourceId: source.id,
							path: absolutePath,
							message:
								'Filesystem modification time is ahead of the system clock; using the stability check instead.',
						});
					}
					if (
						ageMs >= 0 &&
						ageMs < source.minimumAgeSeconds * 1000
					) {
						continue;
					}
					candidates.push({
						sourceId: source.id,
						absolutePath,
						relativePath: relative(root, absolutePath),
						fileName: entry.name,
						size: fileStat.size,
						modifiedAtMs: fileStat.mtimeMs,
						recordedAtMs,
					});
				} catch (error) {
					errors.push({
						sourceId: source.id,
						path: absolutePath,
						message: errorMessage(error),
					});
				}
			}
		};

		await visit(root);
	}
}
