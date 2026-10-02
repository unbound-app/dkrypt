import { describe, expect, test } from 'bun:test';
import AdmZip from 'adm-zip';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compareIpaStructures, readIpaStructure } from '#ipaStructure.js';

describe('IPA structure comparison', () => {
  test('reports added, removed, changed, and unchanged package paths', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'dkrypt-ipa-structure-'));
    const beforePath = path.join(directory, 'before.ipa');
    const afterPath = path.join(directory, 'after.ipa');
    try {
      const before = new AdmZip();
      before.addFile('Payload/App.app/Info.plist', Buffer.from('same'));
      before.addFile('Payload/App.app/old', Buffer.from('old'));
      before.addFile('Payload/App.app/changed', Buffer.from('before'));
      before.writeZip(beforePath);
      const after = new AdmZip();
      after.addFile('Payload/App.app/Info.plist', Buffer.from('same'));
      after.addFile('Payload/App.app/new', Buffer.from('new'));
      after.addFile('Payload/App.app/changed', Buffer.from('after'));
      after.writeZip(afterPath);

      const diff = compareIpaStructures(readIpaStructure(beforePath), readIpaStructure(afterPath));
      expect(diff.counts).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 1 });
      expect(diff.added.map((entry) => entry.path)).toEqual(['Payload/App.app/new']);
      expect(diff.removed.map((entry) => entry.path)).toEqual(['Payload/App.app/old']);
      expect(diff.changed.map((entry) => entry.path)).toEqual(['Payload/App.app/changed']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
