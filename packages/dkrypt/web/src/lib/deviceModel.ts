export type AppleDeviceKind = 'iphone' | 'ipad' | 'ipod' | 'unknown';

const MODEL_NAMES: Record<string, string> = {
  'iPad7,11': 'iPad (7th generation)',
  'iPad7,12': 'iPad (7th generation)',
  'iPhone16,1': 'iPhone 15 Pro',
  'iPhone16,2': 'iPhone 15 Pro Max',
};

function normalized(value?: string): string {
  return value?.trim() ?? '';
}

export function getAppleDeviceKind(productType?: string, fallbackName?: string): AppleDeviceKind {
  const value = normalized(productType) || normalized(fallbackName);
  if (/iPad/i.test(value)) return 'ipad';
  if (/iPhone/i.test(value)) return 'iphone';
  if (/iPod/i.test(value)) return 'ipod';
  return 'unknown';
}

export function getAppleDeviceModelName(productType?: string, fallbackName?: string): string | undefined {
  const value = normalized(productType);
  if (value && MODEL_NAMES[value]) return MODEL_NAMES[value];
  const kind = getAppleDeviceKind(productType, fallbackName);
  if (kind === 'ipad') return 'iPad';
  if (kind === 'iphone') return 'iPhone';
  if (kind === 'ipod') return 'iPod touch';
  return undefined;
}
