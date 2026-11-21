// Pure payment-schedule logic. No React, no storage — easy to test.

export type Frequency = 'monthly' | 'quarterly' | 'yearly';

export const MONTHS_PER: Record<Frequency, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

export const FREQ_LABEL: Record<Frequency, string> = {
  monthly: 'חודשי',
  quarterly: 'רבעוני',
  yearly: 'שנתי',
};

export interface PriceChange {
  date: string; // YYYY-MM-DD — charges on/after this date use newAmount
  newAmount: number;
}

export interface Payment {
  id: string;
  name: string;
  amount: number; // full amount of a single charge
  frequency: Frequency;
  firstChargeDate: string; // YYYY-MM-DD — a charge date; repeats every period after it
  renewalDate?: string; // contract end / renewal reminder (charges continue)
  priceChange?: PriceChange;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface Charge {
  paymentId: string;
  name: string;
  date: string; // YYYY-MM-DD
  day: number;
  amount: number;
  color: string;
}

// ---------- date helpers (all local-calendar, no time zones involved) ----------

export interface YMD {
  y: number;
  m: number; // 1-12
  d: number;
}

export function parseDate(s: string): YMD {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

export function formatDate({ y, m, d }: YMD): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function todayString(now: Date = new Date()): string {
  return formatDate({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
}

export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { y, m, d } = parseDate(s);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

/** 0 = Sunday */
export function weekdayOfFirst(y: number, m: number): number {
  return new Date(y, m - 1, 1).getDay();
}

export function monthIndex(y: number, m: number): number {
  return y * 12 + (m - 1);
}

export function addMonths(y: number, m: number, delta: number): { y: number; m: number } {
  const idx = monthIndex(y, m) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

// ---------- schedule ----------

/** Amount of a single charge that happens on `date`, taking a known price change into account. */
export function amountOn(p: Payment, date: string): number {
  if (p.priceChange && date >= p.priceChange.date) return p.priceChange.newAmount;
  return p.amount;
}

/**
 * The charge date of `p` within month (y, m), or null if it isn't charged that month.
 * A charge on day 31 falls on the last day of shorter months.
 */
export function chargeDateInMonth(p: Payment, y: number, m: number): string | null {
  const a = parseDate(p.firstChargeDate);
  const diff = monthIndex(y, m) - monthIndex(a.y, a.m);
  if (diff < 0 || diff % MONTHS_PER[p.frequency] !== 0) return null;
  return formatDate({ y, m, d: Math.min(a.d, daysInMonth(y, m)) });
}

/** All charges in month (y, m), sorted by day. Full amounts. */
export function chargesInMonth(payments: Payment[], y: number, m: number): Charge[] {
  const out: Charge[] = [];
  for (const p of payments) {
    const date = chargeDateInMonth(p, y, m);
    if (!date) continue;
    out.push({
      paymentId: p.id,
      name: p.name,
      date,
      day: parseDate(date).d,
      amount: amountOn(p, date),
      color: p.color,
    });
  }
  return out.sort((a, b) => a.day - b.day || a.name.localeCompare(b.name));
}

/** Monthly-equivalent cost of one payment at the price in effect on `asOf`. */
export function monthlyShare(p: Payment, asOf: string): number {
  return amountOn(p, asOf) / MONTHS_PER[p.frequency];
}

/** Fixed monthly cost: every payment spread evenly over the months it covers. */
export function monthlyCost(payments: Payment[], asOf: string): number {
  return payments.reduce((sum, p) => sum + monthlyShare(p, asOf), 0);
}

/** Next charge on or after `from`. */
export function nextChargeDate(p: Payment, from: string): string {
  if (p.firstChargeDate >= from) return p.firstChargeDate;
  const f = parseDate(from);
  // Search forward at most one full period (+1 for day clamping edge cases).
  for (let i = 0; i <= MONTHS_PER[p.frequency]; i++) {
    const { y, m } = addMonths(f.y, f.m, i);
    const d = chargeDateInMonth(p, y, m);
    if (d && d >= from) return d;
  }
  // Unreachable for valid data.
  return p.firstChargeDate;
}

export interface MonthSummary {
  total: number;
  paid: number; // charges before `today` this month
  upcoming: number; // charges today or later this month
  count: number;
}

export function monthSummary(payments: Payment[], today: string): MonthSummary {
  const t = parseDate(today);
  const charges = chargesInMonth(payments, t.y, t.m);
  let paid = 0;
  let upcoming = 0;
  for (const c of charges) {
    if (c.date < today) paid += c.amount;
    else upcoming += c.amount;
  }
  return { total: paid + upcoming, paid, upcoming, count: charges.length };
}

export type HeadsUpKind = 'price' | 'renewal';
export interface HeadsUp {
  paymentId: string;
  kind: HeadsUpKind;
  date: string;
  name: string;
  from?: number;
  to?: number;
}

export function daysBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  const ms = Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d);
  return Math.round(ms / 86400000);
}

/** Price changes and renewals coming up within `windowDays` of today. */
export function headsUps(payments: Payment[], today: string, windowDays = 60): HeadsUp[] {
  const out: HeadsUp[] = [];
  for (const p of payments) {
    if (p.priceChange) {
      const n = daysBetween(today, p.priceChange.date);
      if (n >= 0 && n <= windowDays) {
        out.push({
          paymentId: p.id,
          kind: 'price',
          date: p.priceChange.date,
          name: p.name,
          from: p.amount,
          to: p.priceChange.newAmount,
        });
      }
    }
    if (p.renewalDate) {
      const n = daysBetween(today, p.renewalDate);
      if (n >= 0 && n <= windowDays) {
        out.push({ paymentId: p.id, kind: 'renewal', date: p.renewalDate, name: p.name });
      }
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------- formatting ----------

/** ₪ with thousands separators. Rounded to whole shekels unless `exact`. */
export function formatILS(n: number, exact = false): string {
  const hasFraction = Math.abs(n - Math.round(n)) > 0.004;
  const digits = exact && hasFraction ? 2 : 0;
  const s = Math.abs(n).toFixed(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '-' : ''}₪${s}`;
}

const MONTH_NAMES = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];
const MONTH_SHORT = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'];

export function monthName(m: number): string {
  return MONTH_NAMES[m - 1];
}

export function monthShort(m: number): string {
  return MONTH_SHORT[m - 1];
}

/** "10 במרץ" / "10 במרץ 2027" — plain text; the UI isolates it for RTL. */
export function prettyDate(s: string, withYear = false): string {
  const { y, m, d } = parseDate(s);
  return `${d} ב${MONTH_NAMES[m - 1]}${withYear ? ` ${y}` : ''}`;
}
