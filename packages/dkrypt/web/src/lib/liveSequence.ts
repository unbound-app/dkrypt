export class DashboardEventSequenceTracker {
	private lastSequence = 0;

	receive(sequence: number): boolean {
		const gapDetected = this.lastSequence > 0 && (sequence < this.lastSequence || sequence > this.lastSequence + 1);
		this.lastSequence = sequence;
		return gapDetected;
	}

	reset(): void {
		this.lastSequence = 0;
	}
}
