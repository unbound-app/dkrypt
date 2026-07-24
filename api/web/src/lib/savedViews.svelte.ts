import { loadFilterPresets, saveFilterPresets } from '#lib/filterPresets';

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
