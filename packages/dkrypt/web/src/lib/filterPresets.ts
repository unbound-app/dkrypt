export function loadFilterPresets<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

export function saveFilterPresets<T>(key: string, presets: T[]): void {
  localStorage.setItem(key, JSON.stringify(presets));
}
