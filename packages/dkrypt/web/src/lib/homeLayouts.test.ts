import { describe, expect, test } from 'bun:test';
import { DEFAULT_HOME_LAYOUT, DEFAULT_HOME_VIEW_MODES, moveHomeModule, setHomeModuleCollapsed, setHomeModuleHidden } from '#lib/homeLayouts';

describe('Home layout preferences', () => {
  test('keeps the current Home module order as the default', () => {
    expect(DEFAULT_HOME_LAYOUT).toEqual({
      id: 'default',
      name: 'Default',
      order: ['artifacts', 'activeJobs', 'jobHistory'],
      hidden: [],
      collapsed: [],
    });
  });

  test('defaults view modes to the current library and card-based history and device views', () => {
    expect(DEFAULT_HOME_VIEW_MODES).toEqual({ artifacts: 'list', jobHistory: 'cards', devices: 'cards' });
  });

  test('moves modules within bounds without changing the original layout', () => {
    const moved = moveHomeModule(DEFAULT_HOME_LAYOUT, 'jobHistory', -1);
    expect(moved.order).toEqual(['artifacts', 'jobHistory', 'activeJobs']);
    expect(DEFAULT_HOME_LAYOUT.order).toEqual(['artifacts', 'activeJobs', 'jobHistory']);
    expect(moveHomeModule(DEFAULT_HOME_LAYOUT, 'artifacts', -1)).toBe(DEFAULT_HOME_LAYOUT);
  });

  test('hiding a module clears its collapsed state and restoring preserves order', () => {
    const collapsed = setHomeModuleCollapsed(DEFAULT_HOME_LAYOUT, 'artifacts', true);
    const hidden = setHomeModuleHidden(collapsed, 'artifacts', true);
    expect(hidden.hidden).toEqual(['artifacts']);
    expect(hidden.collapsed).toEqual([]);
    expect(setHomeModuleHidden(hidden, 'artifacts', false).order).toEqual(DEFAULT_HOME_LAYOUT.order);
  });
});
