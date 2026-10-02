export interface SettingsSearchItem {
  id: string;
  title: string;
  description: string;
  tab: string;
  subtab: string;
}

export function searchSettings(items: SettingsSearchItem[], query: string): SettingsSearchItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];
  return items.filter((item) => `${item.title} ${item.description} ${item.id}`.toLocaleLowerCase().includes(normalizedQuery));
}
