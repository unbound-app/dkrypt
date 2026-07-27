import { afterEach, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';

const webRoot = new URL('../', import.meta.url).pathname;
const outputPath = new URL('../src/lib/generatedChangelog.ts', import.meta.url);
const originalSource = await readFile(outputPath, 'utf8');

afterEach(async () => {
  await writeFile(outputPath, originalSource);
});

test('includes the latest eight non-chore commits', async () => {
  const git = Bun.which('git');
  expect(git).toBeTruthy();

  const result = Bun.spawnSync([process.execPath, 'scripts/generate-changelog.ts'], { cwd: webRoot });
  expect(result.exitCode).toBe(0);

  const generated = JSON.parse((await readFile(outputPath, 'utf8'))
    .replace('export const GENERATED_CHANGELOG = ', '')
    .replace(' as const;\n', ''));
  const log = Bun.spawnSync([git!, 'log', '--pretty=format:%H%x1f%cs%x1f%s']);
  const expected = new TextDecoder().decode(log.stdout).split('\n').filter(Boolean).map((line) => {
    const [hash, date, title] = line.split('\x1f');
    return { date, title, description: `Released in ${hash.slice(0, 7)}.` };
  }).filter((entry) => !entry.title.startsWith('chore:')).slice(0, 8);

  expect(generated).toEqual(expected);
});
