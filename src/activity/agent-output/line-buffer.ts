export class AgentLineBuffer {
	private carry = new Map<'stdout' | 'stderr', string>();

	push(stream: 'stdout' | 'stderr', chunk: string): string[] {
		const combined = (this.carry.get(stream) ?? '') + chunk;
		const pieces = combined.split(/\r?\n/u);
		this.carry.set(stream, pieces.pop() ?? '');
		return pieces.filter((line) => line !== '');
	}

	flush(stream: 'stdout' | 'stderr'): string[] {
		const tail = this.carry.get(stream) ?? '';
		this.carry.set(stream, '');
		return tail === '' ? [] : [tail];
	}
}
