export const defaultShortcutBindings = {
  palette: 'Mod+K',
  focusSearch: '/',
  batch: 'b',
  help: '?',
  jumpPrefix: 'g',
  home: 'h',
  billing: 'b',
  keys: 'k',
  logs: 'l',
  insights: 'i',
  docs: 'd',
  settings: 's',
} as const;

export type ShortcutBindings = Record<keyof typeof defaultShortcutBindings, string>;

const actionKeys = Object.keys(defaultShortcutBindings) as Array<keyof ShortcutBindings>;
const directActions = ['focusSearch', 'batch', 'help', 'jumpPrefix'] as const;
const tabActions = ['home', 'billing', 'keys', 'logs', 'insights', 'docs', 'settings'] as const;

export function validateShortcutBindings(input: Record<string, string>): ShortcutBindings | undefined {
  if (Object.keys(input).length !== actionKeys.length || actionKeys.some((key) => !(key in input))) return undefined;
  const normalized = Object.fromEntries(actionKeys.map((key) => [key, input[key]!.trim()])) as ShortcutBindings;
  const validSingle = (value: string) => value.length === 1 && /^[a-z0-9/?]$/.test(value);
  if (normalized.palette !== 'Mod+K' && (!validSingle(normalized.palette) || directActions.some((key) => normalized[key] === normalized.palette))) return undefined;
  if ([...directActions, ...tabActions].some((key) => !validSingle(normalized[key]))) return undefined;
  if (new Set(directActions.map((key) => normalized[key])).size !== directActions.length) return undefined;
  if (new Set(tabActions.map((key) => normalized[key])).size !== tabActions.length) return undefined;
  return normalized;
}
