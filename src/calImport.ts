// Reads a Cal ("כאל") card-statement export and finds the fixed payments in it.
// Pure logic, no DOM: tested in Node and run on the phone. Nothing leaves the device.
import { Frequency, Payment, daysBetween, formatDate, parseDate } from './schedule';
import { Cell, Sheet } from './xlsx';

export interface Txn {
  date: string; // YYYY-MM-DD, transaction date
  merchant: string;
  amount: number; // ₪
  type: string;
  standing: boolean; // "הוראת קבע"
}

export interface Statement {
  txns: Txn[];
  from: string;
  to: string;
}

export type CandidateKind = 'standing' | 'variable' | 'repeat' | 'inactive';

export interface Candidate {
  key: string;
  name: string;
  amount: number; // latest charge (or recent average when the amount varies)
  frequency: Frequency;
  lastDate: string;
  count: number;
  kind: CandidateKind;
  standing: boolean;
  variable: boolean;
  stopped: boolean;
  single: boolean;
  priceChange?: { from: number; to: number };
  existingId?: string;
  selected: boolean;
}

// ---------- reading the sheet ----------

const norm = (v: Cell) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** Excel serial (1900 system) or a d/m/y or y-m-d string → YYYY-MM-DD. */
export function toDate(v: Cell): string | null {
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return formatDate({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
  }
  const s = norm(v);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return formatDate({ y: +m[1], m: +m[2], d: +m[3] });
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (+m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return formatDate({ y, m: +m[2], d: +m[1] });
  }
  return null;
}

export function toAmount(v: Cell): number {
  if (typeof v === 'number') return v;
  const s = norm(v).replace(/[₪,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = Number(s);
  return s && Number.isFinite(n) ? n : NaN;
}

interface Columns { date: number; merchant: number; amount: number; type: number }

function findColumns(row: Cell[]): Columns | null {
  const h = row.map(norm);
  const find = (...tests: ((s: string) => boolean)[]) => {
    for (const t of tests) {
      const i = h.findIndex(t);
      if (i >= 0) return i;
    }
    return -1;
  };
  const date = find((s) => s.includes('תאריך') && s.includes('עסקה'), (s) => s.includes('תאריך') && !s.includes('חיוב'));
  const merchant = find((s) => s.includes('בית עסק') || s.includes('בית העסק'), (s) => s.includes('שם העסק'), (s) => s === 'תיאור');
  const amount = find((s) => s.includes('סכום') && s.includes('חיוב'), (s) => s.includes('סכום') && s.includes('ש"ח'), (s) => s.includes('סכום'));
  const type = find((s) => s.includes('סוג') && s.includes('עסקה'), (s) => s.includes('סוג'));
  return date >= 0 && merchant >= 0 && amount >= 0 ? { date, merchant, amount, type } : null;
}

export function parseStatement(sheets: Sheet[]): Statement {
  const txns: Txn[] = [];
  for (const sheet of sheets) {
    const headerAt = sheet.rows.slice(0, 30).findIndex((r) => findColumns(r) !== null);
    if (headerAt < 0) continue;
    const cols = findColumns(sheet.rows[headerAt])!;
    for (const r of sheet.rows.slice(headerAt + 1)) {
      const date = toDate(r[cols.date] ?? null);
      const merchant = norm(r[cols.merchant]);
      const amount = toAmount(r[cols.amount] ?? null);
      if (!date || !merchant || !Number.isFinite(amount)) continue;
      const type = cols.type >= 0 ? norm(r[cols.type]) : '';
      if (amount <= 0 || /זיכוי|השבת|ביטול/.test(type)) continue; // refunds & credits
      txns.push({ date, merchant, amount, type, standing: /הוראת קבע|הוראות קבע|הו"ק/.test(`${type} ${merchant}`) });
    }
  }
  if (!txns.length) throw new Error('no-transactions');
  txns.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { txns, from: txns[0].date, to: txns[txns.length - 1].date };
}

// ---------- finding fixed payments ----------

/** A stable key for a merchant: case-folded, without "הו"ק" and per-charge reference codes. */
export function merchantKey(name: string): string {
  return cleanName(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Display name: drop "הוראת קבע" markers and per-charge reference codes (e.g. "Spotify P425324490"). */
export function cleanName(name: string): string {
  return name
    .replace(/\(?\s*הו"ק\s*\)?/g, ' ')
    .replace(/הוראות? קבע/g, ' ')
    .replace(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{7,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s\-–,]+$/, '')
    .trim() || name.trim();
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const monthOf = (d: string) => d.slice(0, 7);
const day = (d: string) => parseDate(d).d;

interface Series { key: string; names: string[]; txns: Txn[]; standing: boolean }

/** Split one merchant's charges into parallel series when there are several per month (e.g. two Apple subscriptions). */
function splitSeries(key: string, txns: Txn[], standing: boolean): Series[] {
  const byMonth = new Map<string, Txn[]>();
  for (const t of txns) byMonth.set(monthOf(t.date), [...(byMonth.get(monthOf(t.date)) ?? []), t]);
  const perMonth = Math.round(median([...byMonth.values()].map((l) => l.length)));
  if (perMonth < 2) return [{ key, names: txns.map((t) => t.merchant), txns, standing }];
  const series: Txn[][] = Array.from({ length: perMonth }, () => []);
  for (const list of byMonth.values()) {
    const sorted = [...list].sort((a, b) => day(a.date) - day(b.date));
    sorted.forEach((t, i) => series[Math.min(i, perMonth - 1)].push(t));
  }
  return series.map((s, i) => ({ key: `${key}#${i + 1}`, names: s.map((t) => t.merchant), txns: s, standing }));
}

/** Join series that are the same subscription under a changed merchant name (e.g. "SpotifyIL" ↔ "Spotify P…"). */
function mergeRenamed(series: Series[]): Series[] {
  const out: Series[] = [];
  for (const s of [...series].sort((a, b) => b.txns.length - a.txns.length)) {
    const months = new Set(s.txns.map((t) => monthOf(t.date)));
    const last = s.txns[s.txns.length - 1].amount;
    const target = out.find((o) => {
      if (o.standing !== s.standing) return false;
      const a = o.key.replace(/\s/g, '').slice(0, 5);
      const b = s.key.replace(/\s/g, '').slice(0, 5);
      if (a.length < 4 || a !== b) return false;
      const overlap = o.txns.filter((t) => months.has(monthOf(t.date))).length;
      const oLast = o.txns[o.txns.length - 1].amount;
      return overlap <= 1 && Math.abs(oLast - last) <= 0.15 * Math.max(oLast, last) &&
        Math.abs(median(o.txns.map((t) => day(t.date))) - median(s.txns.map((t) => day(t.date)))) <= 3;
    });
    if (target) {
      target.txns = [...target.txns, ...s.txns].sort((a, b) => (a.date < b.date ? -1 : 1));
      target.names.push(...s.names);
    } else out.push({ ...s, txns: [...s.txns], names: [...s.names] });
  }
  return out;
}

function frequencyFor(gap: number): Frequency {
  return gap <= 45 ? 'monthly' : gap <= 76 ? 'bimonthly' : gap <= 135 ? 'quarterly' : 'yearly';
}

const PERIOD_DAYS: Record<Frequency, number> = { monthly: 30.4, bimonthly: 60.9, quarterly: 91.3, yearly: 365 };

function describe(s: Series, end: string): Omit<Candidate, 'existingId' | 'selected'> | null {
  const txns = s.txns;
  const dates = txns.map((t) => t.date);
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
  const single = txns.length === 1;
  const gap = single ? 365 : median(gaps);
  const frequency = single ? 'yearly' : frequencyFor(gap);

  // Ordinary purchases only count when they repeat like a subscription: one per period, steady amount, steady rhythm.
  const recentAmounts = txns.slice(-6).map((t) => t.amount);
  const mean = recentAmounts.reduce((a, b) => a + b, 0) / recentAmounts.length;
  const sd = Math.sqrt(recentAmounts.reduce((a, b) => a + (b - mean) ** 2, 0) / recentAmounts.length);
  const cv = mean ? sd / mean : 0;
  if (!s.standing) {
    if (txns.length < 3) return null;
    const months = new Set(dates.map(monthOf));
    if (months.size !== txns.length) return null;
    if (cv > 0.08) return null;
    if (Math.max(...gaps) > 1.6 * Math.min(...gaps) + 6) return null;
  }
  // Two charges that differ are a price change, not a usage-based amount.
  const variable = s.standing && txns.length >= 3 && cv > 0.2;
  const lastDate = dates[dates.length - 1];
  const stopped = !single && daysBetween(lastDate, end) > PERIOD_DAYS[frequency] * 1.5 + 10;
  const last = txns[txns.length - 1].amount;
  const prev = txns.length > 1 ? txns[txns.length - 2].amount : last;
  const amount = variable ? round2(txns.slice(-3).reduce((a, t) => a + t.amount, 0) / Math.min(3, txns.length)) : last;
  const priceChange = !variable && Math.abs(last - prev) > 0.02 * prev ? { from: prev, to: last } : undefined;
  const latestName = txns[txns.length - 1].merchant;
  const kind: CandidateKind = stopped || single ? 'inactive' : !s.standing ? 'repeat' : variable ? 'variable' : 'standing';
  return {
    key: s.key, name: cleanName(latestName), amount, frequency, lastDate, count: txns.length, kind,
    standing: s.standing, variable, stopped, single, priceChange,
  };
}

export function findFixedPayments(st: Statement, existing: Payment[] = []): Candidate[] {
  const groups = new Map<string, { standing: Txn[]; other: Txn[] }>();
  for (const t of st.txns) {
    const k = merchantKey(t.merchant);
    if (!k) continue;
    const g = groups.get(k) ?? { standing: [], other: [] };
    (t.standing ? g.standing : g.other).push(t);
    groups.set(k, g);
  }
  let series: Series[] = [];
  for (const [k, g] of groups) {
    if (g.standing.length) series.push(...splitSeries(k, g.standing, true));
    else if (g.other.length >= 3) series.push(...splitSeries(k, g.other, false));
  }
  series = mergeRenamed(series);

  const byKey = new Map(existing.filter((p) => p.importKey).map((p) => [p.importKey!, p]));
  const byName = new Map(existing.map((p) => [merchantKey(p.name), p]));
  const order: CandidateKind[] = ['standing', 'repeat', 'variable', 'inactive'];
  return series
    .map((s) => describe(s, st.to))
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .map((c) => {
      const match = byKey.get(c.key) ?? (c.key.includes('#') ? undefined : byName.get(c.key));
      return { ...c, existingId: match?.id, selected: !match && (c.kind === 'standing' || c.kind === 'repeat') };
    })
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.amount / PERIOD_DAYS[b.frequency] - a.amount / PERIOD_DAYS[a.frequency]);
}
