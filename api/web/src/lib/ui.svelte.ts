import { toast } from 'svelte-sonner';
import { getQueryParam, setQueryParams } from '#lib/urlState';

export type Theme = 'dark' | 'light';
export type ThemePref = Theme | 'auto';

function readStoredThemePref(): ThemePref {
  const stored = localStorage.getItem('theme');
  return stored === 'dark' || stored === 'light' ? stored : 'auto';
}

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

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

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(hexA: string, hexB: string): number {
  const [l1, l2] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

function bestContrastText(bgHex: string): string {
  const white = '#ffffff';
  const nearBlack = '#14161a';
  return contrastRatio(white, bgHex) >= contrastRatio(nearBlack, bgHex) ? white : nearBlack;
}

function applyAccent(id: string): void {
  const preset = ACCENT_PRESETS.find((p) => p.id === id) ?? ACCENT_PRESETS[0];
  const accent = themeState.value === 'light' ? preset.light : preset.dark;
  document.documentElement.style.setProperty('--color-accent', accent);
  document.documentElement.style.setProperty('--color-accent-contrast', bestContrastText(accent));
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

export const historyJumpState = $state<{ bundleId: string | null; failureCategory: string | null }>({ bundleId: null, failureCategory: null });

export function jumpToHistoryBundleId(bundleId: string): void {
  historyJumpState.bundleId = bundleId;
  setActiveTab('home');
}

export function jumpToHistoryFailureCategory(category: string): void {
  historyJumpState.failureCategory = category;
  setActiveTab('home');
}

export const keyUsageJumpState = $state<{ keyId: string | null }>({ keyId: null });

export function jumpToKeyUsage(keyId: string): void {
  keyUsageJumpState.keyId = keyId;
  setActiveTab('keys');
}

export const userJumpState = $state<{ username: string | null }>({ username: null });

export function jumpToUser(username: string): void {
  userJumpState.username = username;
  setActiveTab('settings');
  setSettingsSubtab('users');
}

export const focusSearchJumpState = $state<{ requested: boolean }>({ requested: false });

export function requestFocusSearch(): void {
  focusSearchJumpState.requested = true;
  setActiveTab('home');
}

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

export function initUrlTabSync(): void {
  window.addEventListener('popstate', () => {
    const tab = getQueryParam('tab');
    if (tab && VALID_TAB_IDS.includes(tab as TabId) && tab !== tabState.active) tabState.active = tab as TabId;
    const stab = getQueryParam('stab');
    if (stab && stab !== tabState.settingsSubtab) tabState.settingsSubtab = stab;
  });
}
