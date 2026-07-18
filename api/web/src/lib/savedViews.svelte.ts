import { loadFilterPresets, saveFilterPresets } from './filterPresets';

// Generalizes the named-filter-preset pattern that Logs.svelte and JobHistoryPanel.svelte each
// used to reimplement independently (identical name/apply/remove/cap logic, just copy-pasted)
// into one reactive factory. Callers still own their own `apply` (setting local filter state)
// and the shape of what a "preset" captures - this only owns storage + the presets list itself.
export function createSavedViews<T extends { name: string }>(storageKey: string, maxPresets = 10) {
  let presets = $state<T[]>(loadFilterPresets<T>(storageKey));

  function save(preset: T): void {
    presets = [...presets.filter((p) => p.name !== preset.name), preset].slice(-maxPresets);
    saveFilterPresets(storageKey, presets);
  }

  function remove(name: string): void {
    presets = presets.filter((p) => p.name !== name);
    saveFilterPresets(storageKey, presets);
  }

  return {
    get presets() {
      return presets;
    },
    save,
    remove,
  };
}
