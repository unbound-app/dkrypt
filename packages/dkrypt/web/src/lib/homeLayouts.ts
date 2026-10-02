export const HOME_MODULES = ['artifacts', 'activeJobs', 'jobHistory'] as const;

export type HomeModuleId = typeof HOME_MODULES[number];

export interface HomeLayout {
  id: string;
  name: string;
  order: HomeModuleId[];
  hidden: HomeModuleId[];
  collapsed: HomeModuleId[];
}

export const DEFAULT_HOME_LAYOUT: HomeLayout = {
  id: 'default',
  name: 'Default',
  order: [...HOME_MODULES],
  hidden: [],
  collapsed: [],
};

export type HomeViewModes = {
  artifacts: 'list' | 'cards';
  jobHistory: 'list' | 'cards';
  devices: 'list' | 'cards';
};

export const DEFAULT_HOME_VIEW_MODES: HomeViewModes = {
  artifacts: 'list',
  jobHistory: 'cards',
  devices: 'cards',
};

export function moveHomeModule(layout: HomeLayout, module: HomeModuleId, offset: -1 | 1): HomeLayout {
  const index = layout.order.indexOf(module);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= layout.order.length) return layout;
  const order = [...layout.order];
  [order[index], order[target]] = [order[target]!, order[index]!];
  return { ...layout, order };
}

export function setHomeModuleHidden(layout: HomeLayout, module: HomeModuleId, hidden: boolean): HomeLayout {
  const nextHidden = hidden ? [...new Set([...layout.hidden, module])] : layout.hidden.filter((item) => item !== module);
  return { ...layout, hidden: nextHidden, collapsed: hidden ? layout.collapsed.filter((item) => item !== module) : layout.collapsed };
}

export function setHomeModuleCollapsed(layout: HomeLayout, module: HomeModuleId, collapsed: boolean): HomeLayout {
  const nextCollapsed = collapsed ? [...new Set([...layout.collapsed, module])] : layout.collapsed.filter((item) => item !== module);
  return { ...layout, collapsed: nextCollapsed };
}
