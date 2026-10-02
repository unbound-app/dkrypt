import { expect, test } from 'bun:test';
import { checkForTestFlightUpdate } from './testFlightUpdate.js';

const watch = {
  bundleId: 'com.example.app',
  repo: 'owner/repo',
  testFlightPolicy: 'latestNonExpired' as const,
};

test('fails the TestFlight check on the first build-train lookup failure', async () => {
  const requestedTrains: string[] = [];
  const result = await checkForTestFlightUpdate(watch, {
    lookupCurrentVersion: async () => ({ trackId: 42 }),
    listTrains: async () => [
      { trainVersion: '342.0', buildCount: 1 },
      { trainVersion: '341.0', buildCount: 1 },
    ],
    listBuilds: async (_appId, trainVersion) => {
      requestedTrains.push(trainVersion);
      throw new Error('device agent unavailable');
    },
    releaseTagExists: async () => false,
  });

  expect(result).toEqual({
    ok: false,
    appId: 42,
    wouldDispatch: false,
    reason: 'TestFlight builds lookup failed for train 342.0: Error: device agent unavailable',
  });
  expect(requestedTrains).toEqual(['342.0']);
});

test('does not dispatch a potentially stale build after a later train lookup fails', async () => {
  const releaseLookups: string[] = [];
  const result = await checkForTestFlightUpdate(watch, {
    lookupCurrentVersion: async () => ({ trackId: 42 }),
    listTrains: async () => [
      { trainVersion: '342.0', buildCount: 1 },
      { trainVersion: '341.0', buildCount: 1 },
    ],
    listBuilds: async (_appId, trainVersion) => {
      if (trainVersion === '341.0') throw new Error('device agent connection lost');
      return [{ id: 1, cfBundleShortVersion: '342.0', cfBundleVersion: '100', bundleId: watch.bundleId }];
    },
    releaseTagExists: async (_repo, tag) => {
      releaseLookups.push(tag);
      return false;
    },
  });

  expect(result).toMatchObject({ ok: false, wouldDispatch: false, reason: expect.stringContaining('device agent connection lost') });
  expect(releaseLookups).toEqual([]);
});

test('selects the newest build only after every eligible train is checked successfully', async () => {
  const result = await checkForTestFlightUpdate(watch, {
    lookupCurrentVersion: async () => ({ trackId: 42 }),
    listTrains: async () => [
      { trainVersion: '342.0', buildCount: 1 },
      { trainVersion: '341.0', buildCount: 1 },
    ],
    listBuilds: async (_appId, trainVersion) => [{
      id: trainVersion === '342.0' ? 2 : 1,
      cfBundleShortVersion: trainVersion,
      cfBundleVersion: trainVersion === '342.0' ? '100' : '99',
      bundleId: watch.bundleId,
    }],
    releaseTagExists: async () => false,
  });

  expect(result).toMatchObject({
    ok: true,
    latestTag: 'v342.0_100',
    build: { id: 2 },
    wouldDispatch: true,
  });
});
