import { toast } from 'svelte-sonner';

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
}

export function initTheme(): void {
  document.documentElement.setAttribute('data-theme', themeState.value);

  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (themePrefState.value !== 'auto') return;
    const resolved = systemTheme();
    themeState.value = resolved;
    document.documentElement.setAttribute('data-theme', resolved);
  });
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

export interface ToastHistoryEntry {
  id: string;
  message: string;
  type: 'success' | 'error';
  ts: number;
}

const MAX_TOAST_HISTORY = 20;

export const toastHistoryState = $state<{ items: ToastHistoryEntry[] }>({ items: [] });

export function clearToastHistory(): void {
  toastHistoryState.items = [];
}

export function showToast(message: string, type: 'success' | 'error' = 'success'): void {
  if (type === 'error') toast.error(message);
  else toast.success(message);
  toastHistoryState.items = [{ id: crypto.randomUUID(), message, type, ts: Date.now() }, ...toastHistoryState.items].slice(0, MAX_TOAST_HISTORY);
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

export type TabId = 'home' | 'keys' | 'logs' | 'insights' | 'docs' | 'settings';

export const tabState = $state<{ active: TabId; settingsSubtab: string }>({
  active: (localStorage.getItem('activeTab') as TabId | null) ?? 'home',
  settingsSubtab: localStorage.getItem('activeSettingsSubtab') ?? 'scheduler',
});

export function setActiveTab(tab: TabId): void {
  tabState.active = tab;
  localStorage.setItem('activeTab', tab);
  window.scrollTo(0, 0);
}

export function setSettingsSubtab(subtab: string): void {
  tabState.settingsSubtab = subtab;
  localStorage.setItem('activeSettingsSubtab', subtab);
  window.scrollTo(0, 0);
}
