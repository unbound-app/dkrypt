export const DEFAULT_SHORTCUT_BINDINGS = {
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

export type ShortcutAction = keyof typeof DEFAULT_SHORTCUT_BINDINGS;
export type ShortcutBindings = Record<ShortcutAction, string>;

export const shortcutBindingsState = $state<{ value: ShortcutBindings }>({ value: { ...DEFAULT_SHORTCUT_BINDINGS } });

export function setShortcutBindings(bindings: ShortcutBindings): void {
  shortcutBindingsState.value = { ...bindings };
}

export function resetShortcutBindings(): void {
  setShortcutBindings({ ...DEFAULT_SHORTCUT_BINDINGS });
}
