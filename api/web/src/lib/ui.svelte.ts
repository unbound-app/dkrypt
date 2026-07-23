import { toast } from 'svelte-sonner';
import { getQueryParam, setQueryParams } from './urlState';

export type Theme = 'dark' | 'light';
export type ThemePref = Theme | 'auto';

function readStoredThemePref(): ThemePref {
  const stored = localStorage.getItem('theme');
  return stored === 'dark' || stored === 'light' ? stored : 'auto';
}

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// themePrefState is the user's actual choice (including 'auto'); themeState is always the
// resolved dark/light value - most of the app only cares about the latter and never needs to
// know whether it came from an explicit choice or the OS setting.
export const themePrefState = $state<{ value: ThemePref }>({ value: readStoredThemePref() });
export const themeState = $state<{ value: Theme }>({
  value: themePrefState.value === 'auto' ? systemTheme() : themePrefState.value,
});

export function setTheme(pref: ThemePref): void {
  themePrefState.value = pref;
  if (pref === 'auto') localStorage.removeItem('theme');
  else localStorage.setItem('theme', pref);

  const resolved = pref === 'auto' ? systemTheme() : pref;
  themeState.value = resolved;
  document.documentElement.setAttribute('data-theme', resolved);
  applyAccent(accentState.value);
}

export function initTheme(): void {
  document.documentElement.setAttribute('data-theme', themeState.value);

  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (themePrefState.value !== 'auto') return;
    const resolved = systemTheme();
    themeState.value = resolved;
    document.documentElement.setAttribute('data-theme', resolved);
    applyAccent(accentState.value);
  });
}

export interface AccentPreset {
  id: string;
  label: string;
  dark: string;
  light: string;
}

// White --color-accent-contrast (set in app.css) needs to stay legible against every preset here -
// avoid pale/yellow hues that would need a dark contrast color instead.
export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'blue', label: 'Blue', dark: '#5b8cff', light: '#3b66d6' },
  { id: 'teal', label: 'Teal', dark: '#2dd4bf', light: '#0d9488' },
  { id: 'purple', label: 'Purple', dark: '#a78bfa', light: '#7c3aed' },
  { id: 'pink', label: 'Pink', dark: '#f472b6', light: '#db2777' },
  { id: 'orange', label: 'Orange', dark: '#fb923c', light: '#ea580c' },
  { id: 'green', label: 'Green', dark: '#4ade80', light: '#16a34a' },
];

function readStoredAccent(): string {
  const stored = localStorage.getItem('accent');
  return stored && ACCENT_PRESETS.some((p) => p.id === stored) ? stored : 'blue';
}

export const accentState = $state<{ value: string }>({ value: readStoredAccent() });

// --color-accent is theme-scoped in app.css ([data-theme='dark'/'light'] { --color-accent: ... })
// - an inline style on the root element outranks both, so it has to be kept in sync with the
// resolved theme itself (see the two applyAccent() calls above) rather than set once.
function applyAccent(id: string): void {
  const preset = ACCENT_PRESETS.find((p) => p.id === id) ?? ACCENT_PRESETS[0];
  document.documentElement.style.setProperty('--color-accent', themeState.value === 'light' ? preset.light : preset.dark);
}

export function setAccent(id: string): void {
  accentState.value = id;
  localStorage.setItem('accent', id);
  applyAccent(id);
}

export function initAccent(): void {
  applyAccent(accentState.value);
}

export type Density = 'comfortable' | 'compact';

function readStoredDensity(): Density {
  return localStorage.getItem('density') === 'compact' ? 'compact' : 'comfortable';
}

export const densityState = $state<{ value: Density }>({ value: readStoredDensity() });

export function setDensity(density: Density): void {
  densityState.value = density;
  localStorage.setItem('density', density);
  document.documentElement.setAttribute('data-density', density);
}

export function initDensity(): void {
  document.documentElement.setAttribute('data-density', densityState.value);
}

// Defaults off - an existing install shouldn't suddenly start making noise after an upgrade.
export const soundEnabledState = $state<{ value: boolean }>({ value: localStorage.getItem('soundEnabled') === 'true' });

export function setSoundEnabled(enabled: boolean): void {
  soundEnabledState.value = enabled;
  localStorage.setItem('soundEnabled', String(enabled));
}

export interface ToastHistoryEntry {
  id: string;
  message: string;
  type: 'success' | 'error';
  ts: number;
}

const MAX_TOAST_HISTORY = 20;
const TOAST_HISTORY_KEY = 'toastHistory';

function loadToastHistory(): ToastHistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(TOAST_HISTORY_KEY) ?? '[]') as ToastHistoryEntry[];
  } catch {
    return [];
  }
}

export const toastHistoryState = $state<{ items: ToastHistoryEntry[] }>({ items: loadToastHistory() });

function persistToastHistory(): void {
  try {
    localStorage.setItem(TOAST_HISTORY_KEY, JSON.stringify(toastHistoryState.items));
  } catch {
    // localStorage can throw (quota exceeded, private browsing) - state stays correct in-memory either way.
  }
}

export function clearToastHistory(): void {
  toastHistoryState.items = [];
  persistToastHistory();
}

// `track` decides whether this toast also lands in the bell's persistent history (and can bump
// its unread count) - it defaults to errors only. A success toast is almost always the direct,
// immediate result of something the user just clicked (Queued X, Settings saved, Key created) -
// they're already looking right at it, so re-surfacing it as an "unread notification" later is
// just noise. Errors default to tracked since they're worth being able to review after the fact.
export function showToast(
  message: string,
  type: 'success' | 'error' = 'success',
  options?: { track?: boolean; action?: { label: string; onClick: () => void }; id?: string },
): void {
  const toastOptions = options?.action || options?.id ? { action: options.action, id: options.id } : undefined;
  if (type === 'error') toast.error(message, toastOptions);
  else toast.success(message, toastOptions);

  const track = options?.track ?? type === 'error';
  if (!track) return;

  toastHistoryState.items = [{ id: crypto.randomUUID(), message, type, ts: Date.now() }, ...toastHistoryState.items].slice(0, MAX_TOAST_HISTORY);
  persistToastHistory();
}

interface ConfirmState {
  open: boolean;
  message: string;
  variant: 'destructive' | 'default';
  confirmLabel: string;
  resolve?: (value: boolean) => void;
}

export const confirmState = $state<ConfirmState>({ open: false, message: '', variant: 'destructive', confirmLabel: 'Confirm' });

export function confirmDialog(
  message: string,
  options?: { variant?: 'destructive' | 'default'; confirmLabel?: string },
): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.open = true;
    confirmState.message = message;
    confirmState.variant = options?.variant ?? 'destructive';
    confirmState.confirmLabel = options?.confirmLabel ?? 'Confirm';
    confirmState.resolve = resolve;
  });
}

export function resolveConfirm(result: boolean): void {
  confirmState.open = false;
  confirmState.resolve?.(result);
  confirmState.resolve = undefined;
}

export const paletteState = $state<{ open: boolean }>({ open: false });

export function openPalette(): void {
  paletteState.open = true;
}

export function closePalette(): void {
  paletteState.open = false;
}

export const helpState = $state<{ open: boolean }>({ open: false });

export function openHelp(): void {
  helpState.open = true;
}

export function closeHelp(): void {
  helpState.open = false;
}

// Consumed by JobHistoryPanel - lets the command palette jump straight to a bundle ID's history
// without prop-drilling a search-setter through Home.
export const historyJumpState = $state<{ bundleId: string | null }>({ bundleId: null });

export function jumpToHistoryBundleId(bundleId: string): void {
  historyJumpState.bundleId = bundleId;
  setActiveTab('home');
}

// Consumed by Keys - lets the command palette open a specific key's Usage dialog directly
// instead of just landing on the API Keys tab and making you find the row yourself.
export const keyUsageJumpState = $state<{ keyId: string | null }>({ keyId: null });

export function jumpToKeyUsage(keyId: string): void {
  keyUsageJumpState.keyId = keyId;
  setActiveTab('keys');
}

// Consumed by Home - lets the command palette (and the `b` shortcut) open the batch decrypt
// dialog directly instead of just landing on Home and making you find the button yourself.
export const batchDecryptJumpState = $state<{ requested: boolean }>({ requested: false });

export function requestOpenBatch(): void {
  batchDecryptJumpState.requested = true;
  setActiveTab('home');
}

export type TabId = 'home' | 'billing' | 'keys' | 'logs' | 'insights' | 'docs' | 'settings';

const VALID_TAB_IDS: TabId[] = ['home', 'billing', 'keys', 'logs', 'insights', 'docs', 'settings'];

function readInitialTab(): TabId {
  const fromUrl = getQueryParam('tab');
  if (fromUrl && VALID_TAB_IDS.includes(fromUrl as TabId)) return fromUrl as TabId;
  return (localStorage.getItem('activeTab') as TabId | null) ?? 'home';
}

export const tabState = $state<{ active: TabId; settingsSubtab: string }>({
  active: readInitialTab(),
  settingsSubtab: getQueryParam('stab') ?? localStorage.getItem('activeSettingsSubtab') ?? 'scheduler',
});

export function setActiveTab(tab: TabId): void {
  tabState.active = tab;
  localStorage.setItem('activeTab', tab);
  setQueryParams({ tab, stab: tab === 'settings' ? tabState.settingsSubtab : undefined });
  window.scrollTo(0, 0);
}

export function setSettingsSubtab(subtab: string): void {
  tabState.settingsSubtab = subtab;
  localStorage.setItem('activeSettingsSubtab', subtab);
  setQueryParams({ stab: subtab });
  window.scrollTo(0, 0);
}

// Follows external navigation (typing a URL, hitting back/forward, opening a shared link) - the
// app itself only ever uses replaceState, so this only fires for navigation it didn't cause.
export function initUrlTabSync(): void {
  window.addEventListener('popstate', () => {
    const tab = getQueryParam('tab');
    if (tab && VALID_TAB_IDS.includes(tab as TabId) && tab !== tabState.active) tabState.active = tab as TabId;
    const stab = getQueryParam('stab');
    if (stab && stab !== tabState.settingsSubtab) tabState.settingsSubtab = stab;
  });
}
