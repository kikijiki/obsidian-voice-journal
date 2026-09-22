import {
	clearTimeout as cancelTimeout,
	setTimeout as scheduleTimeout,
} from 'node:timers';

export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	return await new Promise<T>((resolve, reject) => {
		const timeout = scheduleTimeout(() => {
			reject(new Error(`${label} timed out after ${timeoutMs.toString()} ms.`));
		}, timeoutMs);
		promise.then(
			(value) => {
				cancelTimeout(timeout);
				resolve(value);
			},
			(error: unknown) => {
				cancelTimeout(timeout);
				reject(error instanceof Error ? error : new Error(`${label} failed.`));
			},
		);
	});
}
