import { expect, test } from 'bun:test';
import { defaultShortcutBindings, validateShortcutBindings } from '#shortcutBindings.js';

test('shortcut bindings reject conflicts and browser-reserved commands', () => {
  expect(validateShortcutBindings({ ...defaultShortcutBindings })).toEqual(defaultShortcutBindings);
  expect(validateShortcutBindings({ ...defaultShortcutBindings, palette: 'Mod+R' })).toBeUndefined();
  expect(validateShortcutBindings({ ...defaultShortcutBindings, batch: '/' })).toBeUndefined();
  expect(validateShortcutBindings({ ...defaultShortcutBindings, billing: 'h' })).toBeUndefined();
  expect(validateShortcutBindings({ ...defaultShortcutBindings, help: 'Escape' })).toBeUndefined();
  expect(validateShortcutBindings({ ...defaultShortcutBindings, extra: 'x' })).toBeUndefined();
});
