import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Payment,
  chargesInMonth,
  formatILS,
  headsUps,
  monthSummary,
  monthlyCost,
  nextChargeDate,
} from '../src/schedule';
import { migrateLegacy, normalizePayment } from '../src/model';

const base = { color: '#000', createdAt: '', updatedAt: '' };
const p = (o: Partial<Payment> & Pick<Payment, 'id' | 'amount' | 'frequency' | 'firstChargeDate'>): Payment => ({
  name: o.id,
  ...base,
  ...o,
});

const insurance = p({ id: 'insurance', amount: 1200, frequency: 'yearly', firstChargeDate: '2026-03-10' });
const gym = p({ id: 'gym', amount: 300, frequency: 'quarterly', firstChargeDate: '2026-01-05' });
const rent = p({ id: 'rent', amount: 5000, frequency: 'monthly', firstChargeDate: '2026-01-01' });

test('yearly ₪1,200 adds ₪100 to monthly cost in every month', () => {
  for (const d of ['2026-01-15', '2026-03-15', '2026-11-11']) {
    assert.equal(monthlyCost([insurance], d), 100);
  }
});

test('yearly ₪1,200 adds the full ₪1,200 to March charges only', () => {
  const march = chargesInMonth([insurance], 2026, 3);
  assert.equal(march.length, 1);
  assert.equal(march[0].amount, 1200);
  assert.equal(march[0].day, 10);
  assert.equal(chargesInMonth([insurance], 2026, 4).length, 0);
  assert.equal(chargesInMonth([insurance], 2027, 3)[0].amount, 1200);
  assert.equal(chargesInMonth([insurance], 2025, 3).length, 0, 'no charges before the first charge date');
});

test('quarterly ₪300 → ₪100/month, full ₪300 every 3rd month', () => {
  assert.equal(monthlyCost([gym], '2026-02-01'), 100);
  const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter((m) => chargesInMonth([gym], 2026, m).length);
  assert.deepEqual(months, [1, 4, 7, 10]);
  assert.equal(chargesInMonth([gym], 2026, 4)[0].amount, 300);
});

test('combined: monthly cost vs. charges this month', () => {
  const all = [insurance, gym, rent];
  assert.equal(monthlyCost(all, '2026-03-01'), 5200);
  assert.equal(monthSummary(all, '2026-03-05').total, 6200); // rent + insurance
  assert.equal(monthSummary(all, '2026-04-05').total, 5300); // rent + gym
  assert.equal(monthSummary(all, '2026-02-05').total, 5000); // rent only
});

test('paid vs. upcoming split within the month', () => {
  const s = monthSummary([insurance, rent], '2026-03-05');
  assert.equal(s.paid, 5000); // rent on the 1st
  assert.equal(s.upcoming, 1200); // insurance on the 10th
  assert.equal(s.count, 2);
});

test('day 31 falls on the last day of shorter months', () => {
  const p31 = p({ id: 'p31', amount: 10, frequency: 'monthly', firstChargeDate: '2026-01-31' });
  assert.equal(chargesInMonth([p31], 2026, 2)[0].date, '2026-02-28');
  assert.equal(chargesInMonth([p31], 2028, 2)[0].date, '2028-02-29');
  assert.equal(chargesInMonth([p31], 2026, 4)[0].date, '2026-04-30');
  assert.equal(chargesInMonth([p31], 2026, 5)[0].date, '2026-05-31');
});

test('next charge date', () => {
  assert.equal(nextChargeDate(insurance, '2026-11-11'), '2027-03-10');
  assert.equal(nextChargeDate(insurance, '2026-03-10'), '2026-03-10');
  assert.equal(nextChargeDate(gym, '2026-11-11'), '2027-01-05');
  assert.equal(nextChargeDate(rent, '2026-11-11'), '2026-12-01');
  const future = p({ id: 'f', amount: 1, frequency: 'monthly', firstChargeDate: '2027-02-01' });
  assert.equal(nextChargeDate(future, '2026-11-11'), '2027-02-01');
});

test('known price change applies from its date', () => {
  const netflix = p({
    id: 'tv', amount: 60, frequency: 'monthly', firstChargeDate: '2026-01-20',
    priceChange: { date: '2027-01-01', newAmount: 72 },
  });
  assert.equal(chargesInMonth([netflix], 2026, 12)[0].amount, 60);
  assert.equal(chargesInMonth([netflix], 2027, 1)[0].amount, 72);
  assert.equal(monthlyCost([netflix], '2026-11-11'), 60);
  assert.equal(monthlyCost([netflix], '2027-01-01'), 72);
  const h = headsUps([netflix], '2026-11-11', 60);
  assert.equal(h.length, 1);
  assert.equal(h[0].kind, 'price');
  assert.equal(h[0].from, 60);
  assert.equal(h[0].to, 72);
  assert.equal(headsUps([netflix], '2026-09-01', 60).length, 0);
});

test('renewal shows as heads-up but does not stop charges', () => {
  const ins = { ...insurance, renewalDate: '2026-12-01' };
  assert.equal(headsUps([ins], '2026-11-11')[0].kind, 'renewal');
  assert.equal(chargesInMonth([ins], 2027, 3).length, 1);
});

test('formatting', () => {
  assert.equal(formatILS(1200), '₪1,200');
  assert.equal(formatILS(33.333), '₪33');
  assert.equal(formatILS(49.9, true), '₪49.90');
  assert.equal(formatILS(50, true), '₪50');
});

test('migrates HTML-prototype data (name/amount/frequency)', () => {
  const legacy = [
    { name: 'Rent', amount: 150, frequency: 'monthly' },
    { name: 'Insurance', amount: 1200, frequency: 'annually' },
    { name: 'Gym', amount: 300, frequency: 'quarterly' },
    { name: '', amount: 5, frequency: 'monthly' }, // invalid, skipped
  ];
  const out = migrateLegacy(legacy, '2026-11-11');
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((x) => x.frequency), ['monthly', 'yearly', 'quarterly']);
  assert.ok(out.every((x) => x.firstChargeDate === '2026-11-01'));
  assert.equal(monthlyCost(out, '2026-11-11'), 150 + 100 + 100);
  assert.ok(out.every((x) => normalizePayment(x) !== null));
});

test('normalizePayment drops broken records but keeps good ones', () => {
  assert.equal(normalizePayment({ id: 'x', name: 'x', amount: 'abc', firstChargeDate: '2026-01-01' }), null);
  assert.equal(normalizePayment({ id: 'x', name: 'x', amount: 5, firstChargeDate: '2026-02-30' }), null);
  assert.equal(normalizePayment({ id: 'x', name: 'x', amount: 5, frequency: 'yearly', firstChargeDate: '2026-02-28' })?.frequency, 'yearly');
});

test('Hebrew dates', async () => {
  const { prettyDate } = await import('../src/schedule');
  assert.equal(prettyDate('2027-03-10'), '10 במרץ');
  assert.equal(prettyDate('2027-03-10', true), '10 במרץ 2027');
});
