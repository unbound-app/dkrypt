import { describe, expect, test } from 'bun:test';
import AdmZip from 'adm-zip';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { streamArtifactZip } from '#artifactZip.js';

describe('artifact ZIP streaming', () => {
  test('streams readable ZIP entries without changing their contents', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'dkrypt-artifact-zip-'));
    const first = path.join(directory, 'first.ipa');
    const second = path.join(directory, 'second.ipa');
    const firstContent = Buffer.from('first already-compressed IPA payload');
    const secondContent = Buffer.from('second IPA payload');
    await writeFile(first, firstContent);
    await writeFile(second, secondContent);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of streamArtifactZip([
        { path: first, name: 'com.example.first.ipa', size: firstContent.length },
        { path: second, name: 'com.example.second.ipa', size: secondContent.length },
      ])) chunks.push(Buffer.from(chunk));
      const zip = new AdmZip(Buffer.concat(chunks));
      expect(zip.getEntry('com.example.first.ipa')?.getData()).toEqual(firstContent);
      expect(zip.getEntry('com.example.second.ipa')?.getData()).toEqual(secondContent);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects duplicate filenames and oversized selections', async () => {
    const duplicate = streamArtifactZip([
      { path: '/dev/null', name: 'same.ipa', size: 0 },
      { path: '/dev/null', name: 'same.ipa', size: 0 },
    ]);
    await expect((async () => {
      for await (const _chunk of duplicate) break;
    })()).rejects.toThrow('ZIP export filenames must be unique');
    await expect((async () => {
      for await (const _chunk of streamArtifactZip(Array.from({ length: 101 }, (_, index) => ({ path: '/dev/null', name: `${index}.ipa`, size: 0 })))) break;
    })()).rejects.toThrow('ZIP exports support 1 to 100 artifacts');
  });
});
