import { describe, expect, it } from 'bun:test';
import { shouldRecordQueueWait } from '#jobs/metrics.js';

describe('job metrics', () => {
  it('only records queue wait for the first attempt', () => {
    expect(shouldRecordQueueWait({})).toBeTrue();
    expect(shouldRecordQueueWait({ retryCount: 0 })).toBeTrue();
    expect(shouldRecordQueueWait({ retryCount: 1 })).toBeFalse();
  });
});
