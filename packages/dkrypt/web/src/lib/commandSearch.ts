export interface SearchableCommand {
  id: string;
  label: string;
  keywords?: string;
}

function fuzzyMatch(label: string, query: string): boolean {
  let idx = 0;
  for (const ch of query) {
    idx = label.indexOf(ch, idx);
    if (idx === -1) return false;
    idx += 1;
  }
  return true;
}

export function scoreCommand(command: SearchableCommand, query: string, recents: string[]): number {
  const q = query.trim().toLowerCase();
  const recentIdx = recents.indexOf(command.id);
  const recentBoost = recentIdx === -1 ? 0 : Math.max(0, 15 - recentIdx);
  const label = command.label.toLowerCase();
  const keywords = command.keywords?.toLowerCase() ?? '';

  if (q === '') return recentIdx === -1 ? 0 : 100 - recentIdx;
  if (label === q) return 200 + recentBoost;
  if (label.startsWith(q)) return 140 + recentBoost;
  if (label.includes(q)) return 100 + recentBoost;
  if (keywords.includes(q)) return 70 + recentBoost;
  if (fuzzyMatch(label, q)) return 50 + recentBoost;
  return -1;
}

export function rankCommands<T extends SearchableCommand>(commands: T[], query: string, recents: string[]): T[] {
  return commands
    .map((command) => ({ command, score: scoreCommand(command, query, recents) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.command.label.localeCompare(b.command.label))
    .map((x) => x.command);
}
