// What deserves a heads-up right now: charges today/tomorrow, price changes and renewals in the next week
// (the overview shows those up to 60 days ahead).
import { Payment, amountOn, daysBetween, headsUps, nextChargeDate } from './schedule';

export type ReminderKind = 'charge' | 'price' | 'renewal';

export interface Reminder {
  key: string;
  kind: ReminderKind;
  paymentId: string;
  name: string;
  date: string;
  days: number;
  amount?: number;
  from?: number;
  to?: number;
}

export const CHARGE_DAYS = 1; // today and tomorrow
export const CHANGE_DAYS = 7;

export function dueReminders(payments: Payment[], today: string): Reminder[] {
  const out: Reminder[] = [];
  for (const p of payments) {
    const next = nextChargeDate(p, today);
    const days = daysBetween(today, next);
    if (days >= 0 && days <= CHARGE_DAYS) {
      out.push({
        key: `charge:${p.id}:${next}`, kind: 'charge', paymentId: p.id, name: p.name,
        date: next, days, amount: amountOn(p, next),
      });
    }
  }
  for (const h of headsUps(payments, today, CHANGE_DAYS)) {
    out.push({
      key: `${h.kind}:${h.paymentId}:${h.date}`, kind: h.kind, paymentId: h.paymentId, name: h.name,
      date: h.date, days: daysBetween(today, h.date), from: h.from, to: h.to,
    });
  }
  return out.sort((a, b) => a.days - b.days || a.name.localeCompare(b.name));
}
