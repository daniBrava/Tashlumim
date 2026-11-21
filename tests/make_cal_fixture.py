"""Builds tests/fixtures/cal-sample.xlsx: a FICTIONAL statement laid out like a Cal ("כאל") export.
Run: python3 tests/make_cal_fixture.py  (needs openpyxl)."""
import datetime as dt
import os
import random
from openpyxl import Workbook

random.seed(7)
wb = Workbook()
ws = wb.active
ws.title = 'פירוט עסקאות וזיכויים'
ws.sheet_view.rightToLeft = True
ws.append(['פירוט עסקאות לישראל ישראלי לחשבון בנק 000000 לכרטיס ויזה 0000'])
ws.merge_cells('A1:H1')
ws.append(['תאריך\nעסקה', 'שם בית עסק', 'סכום\nבש"ח', 'מועד\nחיוב', 'סוג\nעסקה', 'מזהה כרטיס\nבארנק דיגילטי', 'הנחה', 'הערות'])

rows = []
def add(d, name, amount, kind='רגילה', note=None):
    rows.append((d, name, amount, kind, note))

def month_seq(start, n, day, step=1):
    y, m = start
    for _ in range(n):
        yield dt.datetime(y, m, min(day, 28))
        m += step
        while m > 12:
            m -= 12; y += 1

# Standing orders
for i, d in enumerate(month_seq((2025, 6), 18, 11)):           # renamed mid-way
    add(d, 'SpotifyIL' if i < 6 or i > 11 else f'Spotify P4{i}A3C2B9{i}', 43.9 if i >= 3 else 35.9, 'הוראת קבע')
for d in month_seq((2025, 6), 18, 4):                            # two subscriptions, same merchant
    add(d, 'APPLE.COM/BILL', 11.9, 'הוראת קבע')
    add(d + dt.timedelta(days=1), 'APPLE.COM/BILL', 4.9, 'הוראת קבע')
for d in month_seq((2025, 6), 18, 27):                           # usage-based
    add(d, 'פנגו חשבונית חודשית', round(random.uniform(5, 300), 2), 'הוראת קבע')
add(dt.datetime(2026, 10, 18), 'OPENAI *CHATGPT SUBSCR', 45, 'הוראת קבע')   # price change, 2 charges
add(dt.datetime(2026, 11, 18), 'OPENAI *CHATGPT SUBSCR', 70, 'הוראת קבע')
for d in month_seq((2025, 6), 3, 13):                            # stopped
    add(d, 'חברת פרטנר תקשורת בע"מ (הו"ק)', 17.29, 'הוראת קבע')
for d in month_seq((2025, 6), 18, 23):                           # small drift
    add(d, 'שרותי בריאות כללית הו"ק', round(39 + random.uniform(-0.3, 0.5), 2), 'הוראת קבע')
add(dt.datetime(2026, 1, 14), 'Google One', 390, 'הוראת קבע')     # once
# Not a standing order, but regular: municipal tax every two months
for d in month_seq((2025, 7), 9, 20, step=2):
    add(d, 'עיריית תל אביב -ארנונה', round(900 + random.uniform(-15, 15), 1))
# Noise: everyday purchases, credits, pending
for k in range(300):
    d = dt.datetime(2025, 5, 23) + dt.timedelta(days=random.randint(0, 547))
    add(d, random.choice(['Gett', 'שופרסל', 'קפה קפה', 'Wolt', 'פז']), round(random.uniform(10, 250), 2))
add(dt.datetime(2026, 11, 21), 'Gett', -12, 'עסקת זיכוי', 'עסקה בקליטה')
add(dt.datetime(2026, 11, 21), 'אוטלו', 25, 'רכישה רגילה', 'עסקה בקליטה')

for d, name, amount, kind, note in sorted(rows, key=lambda r: r[0], reverse=True):
    charge = None if note == 'עסקה בקליטה' else dt.datetime(d.year + (d.month == 12), d.month % 12 + 1, 2)
    ws.append([d, name, amount, charge, kind, 4870, None, note])
    ws.cell(ws.max_row, 1).number_format = 'd/m/yy;@'
    ws.cell(ws.max_row, 3).number_format = '[$₪] #,##0.00'
    if charge:
        ws.cell(ws.max_row, 4).number_format = 'd/m/yy;@'
ws.append([])
ws.append([None, 'סה"כ עסקאות בגיליון זה:', 12345.67, 'הסכום אינו כולל עסקאות שחויבו במט"ח'])
ws.append(['את המידע המלא על כל עסקה אפשר למצוא באתר ובאפליקציית כאל.'])
out = os.path.join(os.path.dirname(__file__), 'fixtures', 'cal-sample.xlsx')
wb.save(out)
print('wrote', out, len(rows), 'rows')
