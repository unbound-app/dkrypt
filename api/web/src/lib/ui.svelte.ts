import { toast } from 'svelte-sonner';

export type Theme = 'dark' | 'light';

function readStoredTheme(): Theme | null {
  const stored = localStorage.getItem('theme');
  return stored === 'dark' || stored === 'light' ? stored : null;
}

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export const themeState = $state<{ value: Theme | null }>({ value: readStoredTheme() });

export function setTheme(theme: Theme): void {
  themeState.value = theme;
  localStorage.setItem('theme', theme);
  document.documentElement.setAttribute('data-theme', theme);
}

export function initTheme(): void {
  document.documentElement.setAttribute('data-theme', themeState.value ?? systemTheme());

  if (!themeState.value) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (!themeState.value) document.documentElement.setAttribute('data-theme', systemTheme());
    });
  }
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

export type TabId = 'home' | 'keys' | 'logs' | 'docs' | 'settings';

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
