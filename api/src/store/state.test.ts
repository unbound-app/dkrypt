import { afterEach, describe, expect, test } from 'bun:test';
import {
  addAllowedUser,
  exportBackup,
  getDeviceHealthHourlyBuckets,
  getDeviceUptimePercent,
  getSchedulerConfigIssues,
  importBackup,
  listAllowedUsers,
  recordDeviceHealthCheck,
  updateSettings,
  VIEWER_PERMISSIONS,
} from './state.js';

describe('exportBackup / importBackup', () => {
  test('round-trips the allowlist through export and import', () => {
    addAllowedUser('roundtrip-user', { ...VIEWER_PERMISSIONS, decrypt: true }, 'tester');
    const backup = exportBackup();

    expect(backup.backupVersion).toBe(1);
    expect(backup.allowedUsers.some((u) => u.username === 'roundtrip-user')).toBe(true);

    const result = importBackup(backup, 'tester');
    expect(result.ok).toBe(true);
    expect(listAllowedUsers().some((u) => u.username === 'roundtrip-user')).toBe(true);
  });

  test('rejects a backup with the wrong version', () => {
    const backup = exportBackup();
    const result = importBackup({ ...backup, backupVersion: 99 }, 'tester');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/version/);
  });

  test('rejects a backup with a malformed allowedUsers entry', () => {
    const backup = exportBackup();
    const result = importBackup({ ...backup, allowedUsers: [{ username: 'bad' }] }, 'tester');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/allowedUsers/);
  });

  test('rejects a non-object payload', () => {
    expect(importBackup(null, 'tester').ok).toBe(false);
    expect(importBackup('not json', 'tester').ok).toBe(false);
  });

  test('strips any plaintext pendingReveal from imported API keys', () => {
    const backup = exportBackup();
    const tampered = {
      ...backup,
      apiKeys: [
        {
          id: 'k1',
          name: 'sneaky',
          ownerId: 'root',
          status: 'approved' as const,
          createdAt: Date.now(),
          pendingReveal: 'should-not-survive-import',
        },
      ],
    };
    const result = importBackup(tampered, 'tester');
    expect(result.ok).toBe(true);
    const reExported = exportBackup();
    const key = reExported.apiKeys.find((k) => k.id === 'k1');
    expect(key?.pendingReveal).toBeUndefined();
  });
});

describe('getSchedulerConfigIssues', () => {
  afterEach(() => {
    updateSettings({ watchBundleId: '', watchAppRepo: '', ghDispatchRepo: '' });
  });

  test('reports nothing when the scheduler is intentionally left unconfigured', () => {
    expect(getSchedulerConfigIssues()).toEqual([]);
  });

  test('flags a partially-filled config as a likely mistake', () => {
    updateSettings({ watchBundleId: 'com.example.app', watchAppRepo: '', ghDispatchRepo: '' });
    const issues = getSchedulerConfigIssues();
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatch(/partially configured/);
    expect(issues[0]).toMatch(/watch app repo/);
  });

  test('flags a missing GH_TOKEN once all three repo fields are set', () => {
    // test/setup.ts never sets GH_TOKEN, so config.ghToken is '' here.
    updateSettings({ watchBundleId: 'com.example.app', watchAppRepo: 'me/app', ghDispatchRepo: 'me/dispatch' });
    const issues = getSchedulerConfigIssues();
    expect(issues.some((i) => i.includes('GH_TOKEN'))).toBe(true);
  });
});

describe('device health history', () => {
  test('returns undefined uptime before any check has ever been recorded', () => {
    expect(getDeviceUptimePercent(24)).toBeUndefined();
  });

  test('buckets checks by hour and computes an overall uptime percent', () => {
    recordDeviceHealthCheck(true);
    recordDeviceHealthCheck(true);
    recordDeviceHealthCheck(false);

    // Which of the two hourly buckets the checks land in depends on where "now" falls relative to
    // the hour boundary, so only assert the bucket structure here - getDeviceUptimePercent below
    // filters by raw timestamp instead of a bucket index, which is what's actually load-bearing.
    const buckets = getDeviceHealthHourlyBuckets(2);
    expect(buckets).toHaveLength(2);
    expect(buckets.some((b) => b.reachablePercent !== null)).toBe(true);

    const uptime = getDeviceUptimePercent(2);
    expect(uptime).toBeCloseTo(2 / 3);
  });
});
