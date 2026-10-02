export function createVisitedTabs<T extends string>(activeTab: () => T): Partial<Record<T, true>> {
  const initialTab = activeTab();
  const visitedTabs = $state<Partial<Record<T, true>>>({});
  visitedTabs[initialTab] = true;

  $effect(() => {
    visitedTabs[activeTab()] = true;
  });

  return visitedTabs;
}
