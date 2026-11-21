import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { readXlsx } from '../src/xlsx';
import { cleanName, findFixedPayments, merchantKey, parseStatement, toDate } from '../src/calImport';
import { Payment, monthlyCost } from '../src/schedule';

const fixture = () => readXlsx(new Uint8Array(readFileSync(new URL('./fixtures/cal-sample.xlsx', import.meta.url))));
const byName = (cs: ReturnType<typeof findFixedPayments>, name: string) => cs.filter((c) => c.name === name);

test('reads the Cal layout: title row, multi-line headers, footer rows', () => {
  const st = parseStatement(fixture());
  assert.equal(st.from, '2025-05-23');
  assert.equal(st.txns.some((t) => t.amount < 0), false, 'credits skipped');
  assert.equal(st.txns.some((t) => t.merchant.startsWith('סה"כ')), false, 'footer skipped');
  assert.ok(st.txns.find((t) => t.merchant === 'אוטלו'), 'pending purchase kept');
  assert.equal(st.txns.filter((t) => t.standing).length, 96);
});

test('finds standing orders, newest amount, monthly', () => {
  const cs = findFixedPayments(parseStatement(fixture()));
  const spotify = byName(cs, 'SpotifyIL');
  assert.equal(spotify.length, 1, 'renamed merchant merged into one');
  assert.equal(spotify[0].count, 18);
  assert.equal(spotify[0].amount, 43.9);
  assert.equal(spotify[0].frequency, 'monthly');
  assert.equal(spotify[0].selected, true);

  const apple = byName(cs, 'APPLE.COM/BILL');
  assert.deepEqual(apple.map((c) => c.amount).sort(), [11.9, 4.9], 'two subscriptions at one merchant');

  const gpt = byName(cs, 'OPENAI *CHATGPT SUBSCR')[0];
  assert.equal(gpt.amount, 70);
  assert.deepEqual(gpt.priceChange, { from: 45, to: 70 });
  assert.equal(gpt.kind, 'standing');

  assert.equal(byName(cs, 'שרותי בריאות כללית')[0].kind, 'standing', 'small drift is still fixed');
});

test('usage-based, stopped and one-off standing orders are listed but not pre-selected', () => {
  const cs = findFixedPayments(parseStatement(fixture()));
  const pango = byName(cs, 'פנגו חשבונית חודשית')[0];
  assert.equal(pango.kind, 'variable');
  assert.equal(pango.selected, false);
  const partner = byName(cs, 'חברת פרטנר תקשורת בע"מ')[0];
  assert.equal(partner.stopped, true);
  assert.equal(partner.selected, false);
  const g1 = byName(cs, 'Google One')[0];
  assert.equal(g1.single, true);
  assert.equal(g1.selected, false);
});

test('regular non-standing bill every two months → bimonthly', () => {
  const cs = findFixedPayments(parseStatement(fixture()));
  const tax = byName(cs, 'עיריית תל אביב -ארנונה')[0];
  assert.equal(tax.kind, 'repeat');
  assert.equal(tax.frequency, 'bimonthly');
  assert.equal(tax.selected, true);
  assert.equal(cs.some((c) => /Gett|שופרסל|קפה|Wolt|פז/.test(c.name)), false, 'everyday purchases ignored');
});

test('already-imported or same-named payments are marked, not duplicated', () => {
  const st = parseStatement(fixture());
  const existing: Payment[] = [
    { id: 'a', name: 'Spotify IL', amount: 43.9, frequency: 'monthly', firstChargeDate: '2026-01-11', color: '', createdAt: '', updatedAt: '' },
    { id: 'b', name: 'שם אחר', amount: 70, frequency: 'monthly', firstChargeDate: '2026-01-18', importKey: 'openai chatgpt subscr', color: '', createdAt: '', updatedAt: '' },
  ];
  const cs = findFixedPayments(st, existing);
  const gpt = byName(cs, 'OPENAI *CHATGPT SUBSCR')[0];
  assert.equal(gpt.existingId, 'b');
  assert.equal(gpt.selected, false);
});

test('bimonthly counts half per month', () => {
  const p: Payment = { id: 'x', name: 'ארנונה', amount: 900, frequency: 'bimonthly', firstChargeDate: '2026-01-20', color: '', createdAt: '', updatedAt: '' };
  assert.equal(monthlyCost([p], '2026-05-01'), 450);
});

test('names and keys', () => {
  assert.equal(cleanName('Spotify P425324490'), 'Spotify');
  assert.equal(cleanName('בזק הוראות קבע'), 'בזק');
  assert.equal(cleanName('שרותי בריאות כללית הו"ק'), 'שרותי בריאות כללית');
  assert.equal(cleanName('חברת פרטנר תקשורת בע"מ (הו"ק)'), 'חברת פרטנר תקשורת בע"מ');
  assert.equal(merchantKey('NETFLIX.COM'), merchantKey('Netflix.com'));
});

test('dates: Excel serials and text', () => {
  assert.equal(toDate(46347), '2026-11-21');
  assert.equal(toDate('21/11/26'), '2026-11-21');
  assert.equal(toDate('2026-11-21'), '2026-11-21');
  assert.equal(toDate('סה"כ'), null);
});

test('reads namespaced xlsx (x: prefixes, inline strings) like the real Cal export', () => {
  const ns = 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const row = (r: number, cells: string) => `<x:row r="${r}">${cells}</x:row>`;
  const s = (ref: string, i: number) => `<x:c r="${ref}" t="s"><x:v>${i}</x:v></x:c>`;
  const n = (ref: string, v: number) => `<x:c r="${ref}"><x:v>${v}</x:v></x:c>`;
  const inl = (ref: string, t: string) => `<x:c r="${ref}" t="inlineStr"><x:is><x:t>${t}</x:t></x:is></x:c>`;
  const zip = zipSync({
    'xl/workbook.xml': strToU8(`<?xml version="1.0"?><x:workbook ${ns}><x:sheets><x:sheet name="פירוט" sheetId="2" r:id="rId2" /></x:sheets></x:workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/xl/worksheets/sheet1.xml" Id="rId2" /></Relationships>`),
    'xl/sharedStrings.xml': strToU8(`<x:sst ${ns}><x:si><x:t>תאריך
עסקה</x:t></x:si><x:si><x:t>שם בית עסק</x:t></x:si><x:si><x:t>סכום
בש"ח</x:t></x:si><x:si><x:t>סוג
עסקה</x:t></x:si><x:si><x:r><x:t>הוראת </x:t></x:r><x:r><x:t>קבע</x:t></x:r></x:si></x:sst>`),
    'xl/worksheets/sheet1.xml': strToU8(`<x:worksheet ${ns}><x:sheetData>${row(1, inl('A1', 'כותרת &amp; פרטים'))}${row(2, s('A2', 0) + s('B2', 1) + s('C2', 2) + s('E2', 3))}${row(3, n('A3', 46347) + inl('B3', 'HOT') + n('C3', 120.01) + s('E3', 4))}${row(4, n('A4', 46317) + inl('B4', 'HOT') + n('C4', 120.01) + s('E4', 4))}</x:sheetData></x:worksheet>`),
  });
  const sheets = readXlsx(zip);
  assert.equal(sheets[0].rows[0][0], 'כותרת & פרטים');
  const st = parseStatement(sheets);
  assert.deepEqual(st.txns.map((t) => [t.date, t.merchant, t.amount, t.standing]), [
    ['2026-10-22', 'HOT', 120.01, true],
    ['2026-11-21', 'HOT', 120.01, true],
  ]);
});

test('not a spreadsheet / no transactions → clear errors', () => {
  assert.throws(() => readXlsx(strToU8('hello')), /not-xlsx/);
  assert.throws(() => parseStatement([{ name: 'x', rows: [['a', 'b']] }]), /no-transactions/);
});
