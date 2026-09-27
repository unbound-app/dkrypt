import { describe, expect, it } from 'bun:test';
import { DashboardEventSequenceTracker } from '#lib/liveSequence';

describe('dashboard event sequence tracking', () => {
	it('detects missed events in a monotonically increasing stream', () => {
		const tracker = new DashboardEventSequenceTracker();

		expect(tracker.receive(40)).toBe(false);
		expect(tracker.receive(41)).toBe(false);
		expect(tracker.receive(43)).toBe(true);
		expect(tracker.receive(44)).toBe(false);
	});

	it('detects a new sequence epoch and tracks it independently', () => {
		const tracker = new DashboardEventSequenceTracker();

		expect(tracker.receive(40)).toBe(false);
		expect(tracker.receive(41)).toBe(false);
		expect(tracker.receive(1)).toBe(true);
		expect(tracker.receive(2)).toBe(false);
	});

	it('starts clean after an explicit project-state reset', () => {
		const tracker = new DashboardEventSequenceTracker();

		expect(tracker.receive(40)).toBe(false);
		tracker.reset();
		expect(tracker.receive(1)).toBe(false);
	});
});
