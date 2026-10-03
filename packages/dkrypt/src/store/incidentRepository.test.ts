import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { listOperationalIncidents, openIncident, recoverIncident, updateOperationalIncident } from '#store/incidentRepository.js';

test('incidents deduplicate a source and preserve recovery until an operator resolves it', () => {
  const projectId = randomUUID();
  const sourceId = randomUUID();
  const input = { projectId, sourceKey: `device:${sourceId}`, sourceId, kind: 'device' as const, title: 'Device unavailable', detail: 'Test iPad' };
  const opened = openIncident(input);
  expect(openIncident(input).id).toBe(opened.id);
  recoverIncident(input.sourceKey);
  const recovered = listOperationalIncidents(projectId).find((incident) => incident.id === opened.id);
  expect(typeof recovered?.recoveredAt).toBe('number');
  expect(recovered?.status).toBe('open');
  expect(recovered?.history.map((entry) => entry.action)).toEqual(['opened', 'recovered']);
  expect(updateOperationalIncident(opened.id, randomUUID(), 'operator', { status: 'resolved', resolutionNote: 'Checked' })).toBeUndefined();
  expect(() => updateOperationalIncident(opened.id, projectId, 'operator', { status: 'resolved' })).toThrow();
  const resolved = updateOperationalIncident(opened.id, projectId, 'operator', { status: 'resolved', resolutionNote: 'Checked device' });
  expect(resolved?.resolutionNote).toBe('Checked device');
  expect(openIncident(input).status).toBe('open');
});

test('incident assignment and snooze expiry retain an audit trail', async () => {
  const projectId = randomUUID();
  const opened = openIncident({ projectId, sourceKey: `job:${randomUUID()}`, sourceId: randomUUID(), kind: 'job', title: 'Decrypt failed', detail: 'com.example.app' });
  const assigned = updateOperationalIncident(opened.id, projectId, 'manager', { assignedTo: 'operator', status: 'in_progress' });
  expect(assigned?.assignedTo).toBe('operator');
  const snoozedUntil = Date.now() + 20;
  expect(updateOperationalIncident(opened.id, projectId, 'manager', { status: 'snoozed', snoozedUntil })?.status).toBe('snoozed');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const expired = listOperationalIncidents(projectId).find((incident) => incident.id === opened.id);
  expect(expired?.status).toBe('open');
  expect(expired?.history.at(-1)?.action).toBe('snooze_expired');
});

test('a watch incident reopens only after a recovered run fails again', () => {
  const projectId = randomUUID();
  const watchId = randomUUID();
  const input = { projectId, sourceKey: `watch:${watchId}:appStore`, sourceId: watchId, kind: 'watch' as const, title: 'Watch run failed', detail: 'com.example.app' };
  const original = openIncident(input);
  recoverIncident(input.sourceKey);
  const reopened = openIncident(input);
  expect(reopened.id).toBe(original.id);
  expect(reopened.recoveredAt).toBeUndefined();
  expect(openIncident(input).history.map((entry) => entry.action)).toEqual(['opened', 'recovered', 'reopened']);
});
