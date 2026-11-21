// On-device storage (localStorage). Same key as the earlier Expo build, so data entered there
// in this browser carries over; the HTML prototype's key is imported once and left in place.
import { Payment } from './schedule';
import { migrateLegacy, normalizePayment } from './model';

export const KEY = 'fixedPayments:v2';
export const LEGACY_KEY = 'periodicPayments';
const THEME_KEY = 'fixedPayments:theme';
const NOTIFIED_KEY = 'fixedPayments:notified';
const SAVED_AT_KEY = 'fixedPayments:savedAt';

export type Theme = 'device' | 'light' | 'dark';

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function set(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function parseStored(raw: string): Payment[] | null {
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed?.payments;
    if (!Array.isArray(list)) return null;
    return list.map(normalizePayment).filter((p): p is Payment => p !== null);
  } catch {
    return null;
  }
}

export function loadPayments(): Payment[] {
  const raw = get(KEY);
  if (raw != null) {
    const list = parseStored(raw);
    if (list) return list;
    set(`${KEY}:unreadable-${Date.now()}`, raw); // keep it aside, never overwrite silently
    return [];
  }
  const legacy = get(LEGACY_KEY);
  if (legacy != null) {
    try {
      const migrated = migrateLegacy(JSON.parse(legacy));
      if (migrated.length) savePayments(migrated);
      return migrated;
    } catch {
      return [];
    }
  }
  return [];
}

export function serialize(payments: Payment[]): string {
  return JSON.stringify({ version: 2, payments });
}

export function savePayments(payments: Payment[]): boolean {
  const ok = set(KEY, serialize(payments));
  if (ok) set(SAVED_AT_KEY, String(Date.now()));
  return ok;
}

export function savedAt(): number | null {
  const v = Number(get(SAVED_AT_KEY));
  return v > 0 ? v : null;
}

export function loadTheme(): Theme {
  const t = get(THEME_KEY);
  return t === 'light' || t === 'dark' ? t : 'device';
}

export function saveTheme(t: Theme) {
  set(THEME_KEY, t);
}

/** Reminder keys already shown, with the day they were shown (pruned after 60 days). */
export function loadNotified(): Record<string, string> {
  try {
    return JSON.parse(get(NOTIFIED_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

export function saveNotified(map: Record<string, string>) {
  set(NOTIFIED_KEY, JSON.stringify(map));
}
