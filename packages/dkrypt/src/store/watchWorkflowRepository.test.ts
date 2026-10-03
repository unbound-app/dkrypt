import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { deleteWatchDraft, getWatchRevision, listWatchDrafts, recordWatchRevision, saveWatchDraft } from '#store/watchWorkflowRepository.js';
import type { AppWatch } from '#store/state.js';

test('watch drafts are private to their owner and never persist webhook URLs', () => {
  const owner = randomUUID();
  const projectId = randomUUID();
  const draft = saveWatchDraft(owner, projectId, { bundleId: 'com.example.private', webhookUrl: 'https://secret.example/hook' });
  expect(draft.input.webhookUrl).toBeUndefined();
  expect(listWatchDrafts(owner, projectId).some((entry) => entry.id === draft.id)).toBe(true);
  expect(listWatchDrafts(randomUUID(), projectId).some((entry) => entry.id === draft.id)).toBe(false);
  expect(deleteWatchDraft(draft.id, randomUUID())).toBe(false);
  expect(deleteWatchDraft(draft.id, owner)).toBe(true);
});

test('watch revisions keep safe snapshots and readable changed fields', () => {
  const watch = { id: randomUUID(), projectId: randomUUID(), bundleId: 'com.example.release', webhookUrl: 'https://secret.example/hook', pollCron: '0 * * * *', enabled: false, updatedAt: Date.now() } as AppWatch;
  const created = recordWatchRevision(watch, 'tester', 'created');
  expect(created.snapshot.webhookConfigured).toBe(true);
  expect(JSON.stringify(created)).not.toContain('secret.example');
  const changed = recordWatchRevision({ ...watch, pollCron: '30 * * * *' }, 'tester', 'updated', watch);
  expect(changed.changedFields).toContain('pollCron');
  expect(changed.changes?.find((change) => change.field === 'pollCron')).toEqual({ field: 'pollCron', before: '"0 * * * *"', after: '"30 * * * *"' });
  expect(JSON.stringify(changed)).not.toContain('secret.example');
  expect(getWatchRevision(created.id)?.id).toBe(created.id);
});
