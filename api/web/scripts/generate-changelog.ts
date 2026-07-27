interface GeneratedEntry {
  date: string;
  title: string;
  description: string;
}

const outputPath = new URL('../src/lib/generatedChangelog.ts', import.meta.url);

const git = Bun.which('git');

if (git) {
  const result = Bun.spawnSync([git, 'log', '-n', '8', '--pretty=format:%H%x1f%cs%x1f%s']);
  if (result.exitCode === 0) {
    const entries: GeneratedEntry[] = new TextDecoder().decode(result.stdout).split('\n').filter(Boolean).map((line) => {
      const [hash, date, title] = line.split('\x1f');
      return { date, title, description: `Released in ${hash.slice(0, 7)}.` };
    }).filter((entry) => !entry.title.startsWith('chore:'));
    const source = `export const GENERATED_CHANGELOG = ${JSON.stringify(entries, null, 2)} as const;\n`;
    await Bun.write(outputPath, source);
  }
}
