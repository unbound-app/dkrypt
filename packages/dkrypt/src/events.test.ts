import { expect, test } from 'bun:test';
import { closeDashboardConnections, registerDashboardConnection } from '#events.js';

test('dashboard connections can be closed as part of graceful shutdown', () => {
  let closed = 0;
  const unregisterFirst = registerDashboardConnection(() => {
    closed += 1;
  });
  registerDashboardConnection(() => {
    closed += 1;
  });

  closeDashboardConnections();

  expect(closed).toBe(2);
  unregisterFirst();
  closeDashboardConnections();
  expect(closed).toBe(2);
});
