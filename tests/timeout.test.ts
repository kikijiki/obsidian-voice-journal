import { describe, expect, it } from 'vitest';
import { withTimeout } from '../src/providers/timeout';

describe('withTimeout', () => {
	it('returns a completed provider result', async () => {
		await expect(withTimeout(Promise.resolve('ready'), 100, 'Test')).resolves.toBe(
			'ready',
		);
	});

	it('rejects a provider call that never settles', async () => {
		const pending = new Promise<never>(() => undefined);
		await expect(withTimeout(pending, 5, 'Test provider')).rejects.toThrow(
			/timed out/i,
		);
	});
});
