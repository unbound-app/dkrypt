export const LOCALE_PREFERENCES = ['system', 'en', 'de'] as const;

export type FormattingLocalePreference = typeof LOCALE_PREFERENCES[number];
export type InterfaceLanguagePreference = FormattingLocalePreference;
export type InterfaceLanguage = 'en' | 'de';

export function isFormattingLocalePreference(value: unknown): value is FormattingLocalePreference {
  return typeof value === 'string' && LOCALE_PREFERENCES.includes(value as FormattingLocalePreference);
}

export function normalizeFormattingLocalePreference(value: unknown): FormattingLocalePreference {
  return isFormattingLocalePreference(value) ? value : 'system';
}

export function isInterfaceLanguagePreference(value: unknown): value is InterfaceLanguagePreference {
  return isFormattingLocalePreference(value);
}

export function normalizeInterfaceLanguagePreference(value: unknown): InterfaceLanguagePreference {
  return isInterfaceLanguagePreference(value) ? value : 'system';
}

export function resolveInterfaceLanguage(preference: InterfaceLanguagePreference, systemLocales: string[] = []): InterfaceLanguage {
  if (preference === 'en' || preference === 'de') return preference;
  for (const candidate of systemLocales) {
    try {
      const canonical = Intl.getCanonicalLocales(candidate)[0]?.toLowerCase();
      if (canonical?.startsWith('de')) return 'de';
      if (canonical?.startsWith('en')) return 'en';
    } catch {
      continue;
    }
  }
  return 'en';
}

export function resolveLocaleTag(preference: FormattingLocalePreference, systemLocales: string[] = []): string {
  if (preference === 'en') return 'en';
  if (preference === 'de') return 'de-DE';
  for (const candidate of systemLocales) {
    try {
      const canonical = Intl.getCanonicalLocales(candidate)[0];
      if (canonical) return canonical;
    } catch {
      continue;
    }
  }
  return 'en';
}
