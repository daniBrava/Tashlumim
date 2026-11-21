// Pure data helpers: ids, colors, validation and migration of stored payments.
import { Frequency, Payment, isValidDate, todayString } from './schedule';

export const PALETTE = ['#D9A441', '#2E7D74', '#C8553D', '#7D8B4F', '#4F7CA6', '#7B4B6A', '#8A5A3B'];

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function pickColor(existing: Payment[]): string {
  const used = new Map<string, number>();
  for (const p of existing) used.set(p.color, (used.get(p.color) ?? 0) + 1);
  let best = PALETTE[0];
  let bestCount = Infinity;
  for (const c of PALETTE) {
    const n = used.get(c) ?? 0;
    if (n < bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

function toFrequency(f: unknown): Frequency {
  if (f === 'quarterly') return 'quarterly';
  if (f === 'bimonthly') return 'bimonthly';
  if (f === 'yearly' || f === 'annually' || f === 'annual') return 'yearly';
  return 'monthly';
}

/** Turns a payment from the HTML prototype ({name, amount, frequency}) into the current shape. */
export function migrateLegacy(raw: unknown, today = todayString()): Payment[] {
  if (!Array.isArray(raw)) return [];
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  const out: Payment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const name = String(r.name ?? '').trim();
    const amount = Number(r.amount);
    if (!name || !Number.isFinite(amount) || amount <= 0) continue;
    const now = new Date().toISOString();
    out.push({
      id: newId(),
      name,
      amount,
      frequency: toFrequency(r.frequency),
      // The prototype had no charge date — default to the 1st of this month; editable in the app.
      firstChargeDate: firstOfMonth,
      color: pickColor(out),
      createdAt: now,
      updatedAt: now,
    });
  }
  return out;
}

/** Validates/repairs one stored payment; returns null if unusable. */
export function normalizePayment(r: any): Payment | null {
  if (!r || typeof r !== 'object') return null;
  const amount = Number(r.amount);
  if (!r.id || !r.name || !Number.isFinite(amount) || !isValidDate(String(r.firstChargeDate))) return null;
  const p: Payment = {
    id: String(r.id),
    name: String(r.name),
    amount,
    frequency: toFrequency(r.frequency),
    firstChargeDate: String(r.firstChargeDate),
    color: typeof r.color === 'string' ? r.color : PALETTE[0],
    createdAt: String(r.createdAt ?? new Date().toISOString()),
    updatedAt: String(r.updatedAt ?? new Date().toISOString()),
  };
  if (typeof r.importKey === 'string' && r.importKey) p.importKey = r.importKey;
  if (r.renewalDate && isValidDate(String(r.renewalDate))) p.renewalDate = String(r.renewalDate);
  if (r.priceChange && isValidDate(String(r.priceChange.date)) && Number.isFinite(Number(r.priceChange.newAmount))) {
    p.priceChange = { date: String(r.priceChange.date), newAmount: Number(r.priceChange.newAmount) };
  }
  return p;
}

