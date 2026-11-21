import {
  FREQ_LABEL,
  Frequency,
  Payment,
  addMonths,
  amountOn,
  chargesInMonth,
  daysInMonth,
  formatILS,
  headsUps,
  isValidDate,
  monthName,
  monthShort,
  monthSummary,
  monthlyCost,
  monthlyShare,
  nextChargeDate,
  parseDate,
  prettyDate,
  todayString,
  weekdayOfFirst,
} from './schedule';
import { newId, pickColor } from './model';
import * as store from './store';
import { Reminder, dueReminders } from './reminders';

declare global {
  interface Window { BUILD_ID: string }
  interface Navigator { standalone?: boolean }
}

type Tab = 'overview' | 'calendar' | 'settings';
type Filter = 'all' | Frequency;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const pane = $('pane');
const sub = $('sub');
const layer = $('layer');
const toastEl = $('toast');

const state = {
  payments: store.loadPayments(),
  today: todayString(),
  tab: 'overview' as Tab,
  filter: 'all' as Filter,
  cal: (() => { const t = parseDate(todayString()); return { y: t.y, m: t.m }; })(),
  theme: store.loadTheme(),
  editingId: null as string | null | undefined, // undefined = closed, null = new
  saveOk: true,
  updateWaiting: false,
};
const scrollPos: Record<string, number> = {};

// ---------- formatting helpers (RTL-safe) ----------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
/** Money, isolated left-to-right inside Hebrew text. */
const money = (n: number, exact = false) => `<bdi class="num" dir="ltr">${formatILS(n, exact)}</bdi>`;
const n = (v: number | string) => `<bdi class="num" dir="ltr">${v}</bdi>`;
const date = (s: string, withYear = false) => {
  const { y, m, d } = parseDate(s);
  return `${n(d)} ב${monthName(m)}${withYear ? ` ${n(y)}` : ''}`;
};
const daysWord = (d: number) => (d === 0 ? 'היום' : d === 1 ? 'מחר' : d === 2 ? 'מחרתיים' : `בעוד ${n(d)} ימים`);
const isThisYear = (s: string) => s.slice(0, 4) === state.today.slice(0, 4);

// ---------- persistence ----------

function commit(next: Payment[], message?: string, undo?: () => void) {
  state.payments = next;
  state.saveOk = store.savePayments(next);
  if (!state.saveOk) toast('לא הצלחתי לשמור במכשיר. נסה שוב.');
  else if (message) toast(message, undo ? { label: 'ביטול', run: undo } : undefined);
  render();
  refreshReminders(false);
  askPersistentStorage();
}

let persistAsked = false;
function askPersistentStorage() {
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  navigator.storage.persist().catch(() => {});
}

// ---------- rendering ----------

const TITLES: Record<Tab, string> = { overview: 'תשלומים קבועים', calendar: 'לוח חיובים', settings: 'הגדרות' };

function render() {
  const keep = pane.scrollTop;
  $('title').textContent = TITLES[state.tab];
  $('topActions').innerHTML =
    state.tab === 'settings' ? '' : `<button class="icon-btn" type="button" data-action="new" aria-label="תשלום חדש">+</button>`;
  document.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === state.tab));
  pane.innerHTML = state.tab === 'overview' ? overviewHTML() : state.tab === 'calendar' ? calendarHTML() : settingsHTML();
  pane.scrollTop = keep;
  renderSync();
  if (state.tab === 'calendar') centerActiveChip();
}

function renderSync() {
  const at = store.savedAt();
  const el = $('sync');
  if (!state.saveOk) {
    el.textContent = 'השמירה במכשיר נכשלה';
    return;
  }
  el.textContent = at ? `נשמר במכשיר · ${new Date(at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}` : 'נשמר במכשיר בלבד';
}

function alertsHTML(): string {
  const items: string[] = [];
  for (const r of dueReminders(state.payments, state.today)) {
    if (r.kind !== 'charge') continue;
    items.push(alertRow(r.paymentId, 'var(--teal)', `<strong>${daysWord(r.days)}</strong> ${esc(r.name)} · ${money(r.amount!, true)}`));
  }
  for (const h of headsUps(state.payments, state.today, 60)) {
    const when = `<strong>${date(h.date, !isThisYear(h.date))}</strong>`;
    items.push(
      h.kind === 'price'
        ? alertRow(h.paymentId, 'var(--orange)', `${when} ${esc(h.name)} מתייקר מ־${money(h.from!, true)} ל־${money(h.to!, true)}`)
        : alertRow(h.paymentId, 'var(--mustard)', `${when} חידוש או סיום חוזה: ${esc(h.name)}`),
    );
  }
  return items.length ? `<div class="alerts" data-testid="heads-up">${items.join('')}</div>` : '';
}

function alertRow(id: string, color: string, html: string) {
  return `<button class="alert" type="button" data-action="edit" data-id="${esc(id)}"><span class="alert-mark" style="background:${color}"></span><span>${html}</span></button>`;
}

function overviewHTML(): string {
  const { payments, today } = state;
  const month = monthSummary(payments, today);
  const mName = monthName(parseDate(today).m);
  const sub = month.count === 0 ? 'אין חיובים החודש' : month.upcoming === 0 ? 'הכול כבר חויב' : `עוד ${money(month.upcoming)} עד סוף החודש`;

  let html = `
  <div class="totals">
    <div class="card hero" data-testid="monthly-card">
      <div class="k-label">עלות חודשית קבועה</div>
      <div class="k-value" data-testid="monthly-cost">${money(monthlyCost(payments, today))}</div>
      <div class="k-sub">כולל חלק יחסי של שנתי ורבעוני</div>
    </div>
    <div class="card side" data-testid="month-card">
      <div class="k-label">חיובים ב${mName}</div>
      <div class="k-value" data-testid="month-total">${money(month.total)}</div>
      <div class="k-sub">${sub}</div>
    </div>
  </div>
  ${alertsHTML()}`;

  if (!payments.length) {
    return html + `
    <div class="section">התשלומים שלך</div>
    <button class="empty" type="button" data-action="new" data-testid="empty-add">
      <h3>עוד אין תשלומים קבועים</h3>
      <p>שכירות, ביטוחים, מנויים… הוסף אותם וראה כמה הם עולים לך באמת כל חודש.</p>
      <span class="cta">+ הוספת תשלום ראשון</span>
    </button>`;
  }

  const counts: Record<Filter, number> = { all: payments.length, monthly: 0, quarterly: 0, yearly: 0 };
  payments.forEach((p) => counts[p.frequency]++);
  const filters: Filter[] = ['all', 'monthly', 'quarterly', 'yearly'];
  const chips = filters
    .filter((f) => f === 'all' || counts[f] > 0)
    .map((f) => `<button type="button" class="chip${state.filter === f ? ' on' : ''}" data-action="filter" data-filter="${f}">${f === 'all' ? 'הכול' : FREQ_LABEL[f]} <span class="chip-sub">${n(counts[f])}</span></button>`)
    .join('');

  const rows = payments
    .filter((p) => state.filter === 'all' || p.frequency === state.filter)
    .map((p) => ({ p, next: nextChargeDate(p, today) }))
    .sort((a, b) => (a.next < b.next ? -1 : a.next > b.next ? 1 : a.p.name.localeCompare(b.p.name, 'he')))
    .map(({ p, next }) => `
      <button class="row" type="button" data-action="edit" data-id="${esc(p.id)}" data-testid="row-${esc(p.name)}">
        <span class="dot" style="background:${p.color}">${esc(p.name.trim().charAt(0))}</span>
        <span class="row-main">
          <span class="row-name">${esc(p.name)}</span>
          <span class="row-meta" data-testid="meta">${FREQ_LABEL[p.frequency]} · הבא ${date(next, !isThisYear(next))}</span>
        </span>
        <span class="row-amt">
          ${money(amountOn(p, next), true)}
          ${p.frequency !== 'monthly' ? `<span class="per">${money(monthlyShare(p, today))} לחודש</span>` : ''}
        </span>
      </button>`)
    .join('');

  return html + `
    <div class="section">התשלומים שלך</div>
    ${filters.filter((f) => f !== 'all' && counts[f] > 0).length > 1 ? `<div class="chips" data-testid="filters">${chips}</div>` : ''}
    <div class="list">${rows || '<p class="help" style="padding:14px 0">אין תשלומים בסינון הזה.</p>'}</div>`;
}

function shortAmount(v: number): string {
  const r = Math.round(v);
  if (r >= 100000) return `${Math.round(r / 1000)}K`;
  if (r >= 10000) return `${(r / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return r.toLocaleString('en-US');
}

function calendarHTML(): string {
  const { y, m } = state.cal;
  const t = parseDate(state.today);
  const charges = chargesInMonth(state.payments, y, m);
  const total = charges.reduce((s, c) => s + c.amount, 0);

  // Month chips: this month and the next 11 — doubles as a quick trend of what's due when.
  const chips: string[] = [];
  for (let i = 0; i < 12; i++) {
    const mm = addMonths(t.y, t.m, i);
    const sum = chargesInMonth(state.payments, mm.y, mm.m).reduce((s, c) => s + c.amount, 0);
    const on = mm.y === y && mm.m === m;
    chips.push(`<button type="button" class="chip${on ? ' on' : ''}" data-action="month" data-y="${mm.y}" data-m="${mm.m}">${monthShort(mm.m)}${mm.y !== t.y ? ` ${n(String(mm.y).slice(2))}` : ''} <span class="chip-sub">${money(sum)}</span></button>`);
  }

  const byDay = new Map<number, typeof charges>();
  charges.forEach((c) => byDay.set(c.day, [...(byDay.get(c.day) ?? []), c]));
  const lead = weekdayOfFirst(y, m);
  const days = daysInMonth(y, m);
  const cells: string[] = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'].map((w) => `<div class="wd">${w}</div>`);
  for (let i = 0; i < lead; i++) cells.push('<div class="cell"></div>');
  for (let d = 1; d <= days; d++) {
    const col = (lead + d - 1) % 7;
    const list = byDay.get(d);
    const sum = list?.reduce((s, c) => s + c.amount, 0) ?? 0;
    const isToday = y === t.y && m === t.m && d === t.d;
    cells.push(`<div class="cell${col >= 5 ? ' we' : ''}${isToday ? ' today' : ''}" data-testid="day-${d}">
      <span class="dnum">${d}</span>
      ${list ? `<span class="circle" style="background:${list[0].color}" data-testid="charge-day-${d}">${shortAmount(sum)}${list.length > 1 ? `<span class="badge">${list.length}</span>` : ''}</span>` : ''}
    </div>`);
  }

  const rows = charges
    .map((c) => `<button class="cal-row" type="button" data-action="edit" data-id="${esc(c.paymentId)}"><span class="day">${c.day}</span><span class="sdot" style="background:${c.color}"></span><span class="nm">${esc(c.name)}</span>${money(c.amount)}</button>`)
    .join('');

  return `
  <div class="chips" data-testid="month-chips">${chips.join('')}</div>
  <div class="cal-head">
    <button class="round-btn" type="button" data-action="cal-step" data-step="-1" aria-label="החודש הקודם" data-testid="prev-month">›</button>
    <button class="cal-title" type="button" data-action="cal-today">
      <b data-testid="cal-month">${monthName(m)} ${n(y)}</b>
      <span data-testid="cal-total">${charges.length ? `${money(total)} ב־${n(charges.length)} ${charges.length === 1 ? 'חיוב' : 'חיובים'}` : 'אין חיובים'}</span>
    </button>
    <button class="round-btn" type="button" data-action="cal-step" data-step="1" aria-label="החודש הבא" data-testid="next-month">‹</button>
  </div>
  <div class="grid">${cells.join('')}</div>
  ${charges.length ? `<div class="list cal-list">${rows}</div>` : ''}`;
}

function centerActiveChip() {
  const strip = pane.querySelector<HTMLElement>('[data-testid="month-chips"]');
  const on = strip?.querySelector<HTMLElement>('.chip.on');
  if (strip && on) strip.scrollLeft = on.offsetLeft - strip.clientWidth / 2 + on.clientWidth / 2;
}

// ---------- settings ----------

const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

function notificationsHTML(): string {
  const shareIcon = `<svg class="share-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M8 7l4-4 4 4M6 11H5v10h14V11h-1"/></svg>`;
  if (isIOS() && !isStandalone()) {
    return `<div class="group" data-testid="install-help">
      <span class="status warn">צריך להוסיף למסך הבית</span>
      <p style="margin-top:8px">באייפון אפשר לקבל תזכורות ולראות מספר על האייקון רק כשהאפליקציה פתוחה ממסך הבית (iOS ${n('16.4')} ומעלה):</p>
      <ol>
        <li>בספארי, לוחצים על כפתור השיתוף ${shareIcon}</li>
        <li>בוחרים „הוספה למסך הבית”</li>
        <li>פותחים את „קבועים” מהאייקון וחוזרים לכאן</li>
      </ol>
    </div>`;
  }
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    return `<div class="group"><span class="status">לא נתמך</span><p style="margin-top:8px">הדפדפן הזה לא תומך בהתראות. התזכורות עדיין מוצגות בראש מסך הסקירה.</p></div>`;
  }
  const perm = Notification.permission;
  const explain = `<p>תזכורת יום לפני כל חיוב, ושבוע לפני שינוי מחיר או חידוש חוזה. מספר הפריטים הקרובים מופיע על אייקון האפליקציה.</p>`;
  if (perm === 'granted') {
    return `<div class="group" data-testid="notif">
      <span class="status ok">תזכורות פעילות</span>
      <p style="margin-top:8px">התזכורות נבדקות בכל פעם שהאפליקציה נפתחת. אין שרת, ולכן כשהאפליקציה סגורה לגמרי לא נשלחות התראות.</p>
      <button class="btn btn-ghost" type="button" data-action="test-notif">שליחת תזכורת לדוגמה</button>
    </div>`;
  }
  if (perm === 'denied') {
    return `<div class="group" data-testid="notif"><span class="status warn">התראות חסומות</span><p style="margin-top:8px">אפשר להפעיל אותן מחדש בהגדרות המכשיר › התראות › קבועים.</p></div>`;
  }
  return `<div class="group" data-testid="notif">${explain}<button class="btn btn-teal" type="button" data-action="enable-notif" data-testid="enable-notif">הפעלת תזכורות</button></div>`;
}

function settingsHTML(): string {
  const themes: [store.Theme, string][] = [['device', 'לפי המכשיר'], ['light', 'בהיר'], ['dark', 'כהה']];
  return `
  <div class="section" style="margin-top:6px">מראה</div>
  <div class="segment" data-testid="theme">${themes.map(([v, l]) => `<button type="button" class="${state.theme === v ? 'on' : ''}" data-action="theme" data-theme="${v}">${l}</button>`).join('')}</div>

  <div class="section">תזכורות</div>
  ${notificationsHTML()}

  <div class="section">גיבוי</div>
  <div class="group">
    <p>הנתונים נשמרים רק במכשיר הזה, בלי חשבון ובלי שרת. כדאי לשמור גיבוי מדי פעם.</p>
    <button class="btn btn-ghost" type="button" data-action="export" data-testid="export">שמירת קובץ גיבוי</button>
    <label class="btn btn-ghost" style="margin-top:10px">שחזור מקובץ גיבוי<input type="file" accept="application/json,.json" data-action="import" hidden data-testid="import"></label>
  </div>

  <div class="section">על האפליקציה</div>
  <div class="group"><p>קבועים · גרסה ${n(window.BUILD_ID)}<br>${n(state.payments.length)} תשלומים שמורים</p></div>`;
}

function applyTheme(t: store.Theme) {
  state.theme = t;
  store.saveTheme(t);
  const root = document.documentElement;
  if (t === 'device') delete root.dataset.theme;
  else root.dataset.theme = t;
  // Keep the status-bar / browser chrome color in step with a forced theme.
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  metas.forEach((m) => {
    const isDark = (m.getAttribute('media') || '').includes('dark');
    if (t === 'device') m.content = isDark ? '#1E1916' : '#F4ECDD';
    else m.content = t === 'dark' ? '#1E1916' : '#F4ECDD';
  });
}

// ---------- editor (full-screen sub-view) ----------

function plusYear(d: string): string {
  const p = parseDate(d);
  const { y, m } = addMonths(p.y, p.m, 12);
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(p.d, 28)).padStart(2, '0')}`;
}

let editorToken = 0;

function openEditor(id: string | null, push = true) {
  const p = id ? state.payments.find((x) => x.id === id) : undefined;
  if (id && !p) return;
  editorToken++;
  scrollPos[state.tab] = pane.scrollTop;
  state.editingId = id;
  const today = state.today;
  const freq = p?.frequency ?? 'monthly';
  sub.innerHTML = `
    <div class="sub-bar">
      <button class="text-btn" type="button" data-action="back" data-testid="editor-cancel">ביטול</button>
      <h2>${p ? 'עריכת תשלום' : 'תשלום חדש'}</h2>
      <button class="text-btn strong" type="button" data-action="save" data-testid="editor-save">שמירה</button>
    </div>
    <form class="sub-pane" id="form" novalidate autocomplete="off">
      <label class="field-label" for="f-name">שם</label>
      <input class="input" id="f-name" name="name" maxlength="60" placeholder="למשל: ביטוח רכב" value="${esc(p?.name ?? '')}" data-testid="input-name" enterkeyhint="next">

      <label class="field-label" for="f-amount">סכום כל חיוב</label>
      <div class="money"><input class="input" id="f-amount" name="amount" inputmode="decimal" placeholder="0" value="${p ? p.amount : ''}" data-testid="input-amount"></div>

      <span class="field-label">כל כמה זמן</span>
      <div class="segment" role="radiogroup">
        ${(['monthly', 'quarterly', 'yearly'] as Frequency[]).map((f) => `<button type="button" role="radio" aria-checked="${f === freq}" class="${f === freq ? 'on' : ''}" data-action="freq" data-freq="${f}" data-testid="freq-${f}">${FREQ_LABEL[f]}</button>`).join('')}
      </div>
      <input type="hidden" name="frequency" value="${freq}">

      <label class="field-label" for="f-date">תאריך חיוב</label>
      <input class="input" type="date" id="f-date" name="date" value="${p?.firstChargeDate ?? today}" data-testid="input-date">
      <p class="help">החיוב הראשון או כל חיוב קודם. מכאן הוא חוזר.</p>

      <div class="preview" id="preview" data-testid="editor-preview" hidden></div>

      <div class="section">תזכורות</div>
      <div class="box">
        <label class="switch-row"><span>שינוי מחיר ידוע</span><span class="toggle"><input type="checkbox" name="hasPrice" ${p?.priceChange ? 'checked' : ''} data-testid="switch-price"><span></span></span></label>
        <div class="sub-fields" id="price-fields" ${p?.priceChange ? '' : 'hidden'}>
          <label class="field-label" for="f-pdate">החל מ־</label>
          <input class="input" type="date" id="f-pdate" name="priceDate" value="${p?.priceChange?.date ?? plusYear(today)}" data-testid="input-price-date">
          <label class="field-label" for="f-pamount">הסכום החדש לכל חיוב</label>
          <div class="money"><input class="input" id="f-pamount" name="priceAmount" inputmode="decimal" placeholder="0" value="${p?.priceChange?.newAmount ?? ''}" data-testid="input-price-amount"></div>
        </div>
        <label class="switch-row"><span>חידוש או סיום חוזה</span><span class="toggle"><input type="checkbox" name="hasRenewal" ${p?.renewalDate ? 'checked' : ''} data-testid="switch-renewal"><span></span></span></label>
        <div class="sub-fields" id="renewal-fields" ${p?.renewalDate ? '' : 'hidden'}>
          <label class="field-label" for="f-rdate">בתאריך</label>
          <input class="input" type="date" id="f-rdate" name="renewalDate" value="${p?.renewalDate ?? plusYear(today)}" data-testid="input-renewal-date">
        </div>
      </div>
      <p class="help">מופיע בראש מסך הסקירה ב־${n(60)} הימים שלפני.</p>

      <div class="error" id="form-error" data-testid="editor-error" hidden></div>
      <button class="btn btn-primary" type="submit" style="margin-top:22px" data-testid="editor-save-bottom">${p ? 'שמירת שינויים' : 'הוספת תשלום'}</button>
      ${p ? `<button class="btn btn-danger-outline" type="button" style="margin-top:10px" data-action="delete" data-testid="editor-delete">מחיקת תשלום</button>` : ''}
    </form>
    <div class="edge" aria-hidden="true"></div>`;
  sub.hidden = false;
  sub.classList.remove('leave');
  sub.style.transform = '';
  sub.classList.add('enter');
  sub.addEventListener('animationend', () => sub.classList.remove('enter'), { once: true });
  updatePreview();
  if (push) history.pushState({ editor: id ?? 'new' }, '', id ? `#edit/${id}` : '#new');
  if (!p) setTimeout(() => (sub.querySelector('#f-name') as HTMLInputElement | null)?.focus(), 280);
}

function form(): HTMLFormElement {
  return sub.querySelector('#form') as HTMLFormElement;
}

function parseAmount(s: string): number {
  const v = Number(String(s).replace(/[₪,\s]/g, ''));
  return Number.isFinite(v) ? v : NaN;
}

function readForm() {
  const f = form();
  const fd = new FormData(f);
  return {
    name: String(fd.get('name') ?? '').trim(),
    amount: parseAmount(String(fd.get('amount') ?? '')),
    frequency: String(fd.get('frequency')) as Frequency,
    date: String(fd.get('date') ?? ''),
    hasPrice: fd.get('hasPrice') === 'on',
    priceDate: String(fd.get('priceDate') ?? ''),
    priceAmount: parseAmount(String(fd.get('priceAmount') ?? '')),
    hasRenewal: fd.get('hasRenewal') === 'on',
    renewalDate: String(fd.get('renewalDate') ?? ''),
  };
}

function updatePreview() {
  const v = readForm();
  const el = sub.querySelector('#preview') as HTMLElement;
  if (!(v.amount > 0) || !isValidDate(v.date)) {
    el.hidden = true;
    return;
  }
  const p: Payment = { id: 'x', name: v.name, amount: v.amount, frequency: v.frequency, firstChargeDate: v.date, color: '', createdAt: '', updatedAt: '' };
  const next = nextChargeDate(p, state.today);
  el.innerHTML = `נספר כ־${money(monthlyShare(p, state.today))} בחודש · החיוב הבא ${date(next, !isThisYear(next))}`;
  el.hidden = false;
}

function formError(msg: string) {
  const el = sub.querySelector('#form-error') as HTMLElement;
  el.textContent = msg;
  el.hidden = false;
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function saveEditor() {
  const v = readForm();
  if (!v.name) return formError('צריך לתת שם לתשלום.');
  if (!(v.amount > 0)) return formError('צריך להזין את הסכום של חיוב אחד.');
  if (!isValidDate(v.date)) return formError('צריך לבחור תאריך חיוב.');
  let priceChange: Payment['priceChange'];
  if (v.hasPrice) {
    if (!(v.priceAmount > 0) || !isValidDate(v.priceDate)) return formError('צריך להזין תאריך ומחיר חדש, או לכבות את שינוי המחיר.');
    priceChange = { date: v.priceDate, newAmount: v.priceAmount };
  }
  if (v.hasRenewal && !isValidDate(v.renewalDate)) return formError('צריך לבחור תאריך חידוש.');
  const id = state.editingId;
  const old = id ? state.payments.find((x) => x.id === id) : undefined;
  const now = new Date().toISOString();
  const p: Payment = {
    id: old?.id ?? newId(),
    name: v.name,
    amount: v.amount,
    frequency: v.frequency,
    firstChargeDate: v.date,
    priceChange,
    renewalDate: v.hasRenewal ? v.renewalDate : undefined,
    color: old?.color ?? pickColor(state.payments),
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
  };
  const next = old ? state.payments.map((x) => (x.id === p.id ? p : x)) : [...state.payments, p];
  closeEditor();
  commit(next, old ? 'השינויים נשמרו' : 'התשלום נוסף');
}

function closeEditor(fromPop = false) {
  if (state.editingId === undefined) return;
  state.editingId = undefined;
  (document.activeElement as HTMLElement | null)?.blur?.();
  sub.classList.remove('enter');
  sub.style.transition = '';
  sub.classList.add('leave');
  const token = ++editorToken;
  const done = () => {
    if (token !== editorToken) return; // the editor was reopened meanwhile
    sub.hidden = true;
    sub.classList.remove('leave');
    sub.style.transform = '';
    sub.innerHTML = '';
  };
  sub.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 320);
  if (!fromPop && /^#(edit|new)/.test(location.hash)) history.back();
  pane.scrollTop = scrollPos[state.tab] ?? 0;
  if (state.updateWaiting) maybeApplyUpdate();
}

function confirmDelete() {
  const id = state.editingId;
  const p = id ? state.payments.find((x) => x.id === id) : undefined;
  if (!p) return;
  openSheet(`
    <h3>למחוק את „${esc(p.name)}”?</h3>
    <p>התשלום יוסר מהסיכומים ומהלוח.</p>
    <button class="btn btn-danger" type="button" data-action="confirm-delete" data-testid="confirm-delete">מחיקה</button>
    <button class="btn btn-ghost" type="button" data-action="close-sheet">ביטול</button>`);
}

function doDelete() {
  const id = state.editingId;
  const before = state.payments;
  const p = before.find((x) => x.id === id);
  closeSheet();
  closeEditor();
  if (!p) return;
  commit(before.filter((x) => x.id !== id), `„${p.name}” נמחק`, () => commit(before, 'המחיקה בוטלה'));
}

// ---------- sheets & toast ----------

function openSheet(html: string) {
  layer.innerHTML = `<div class="scrim" data-action="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" data-testid="sheet"><div class="grabber"></div>${html}</div>`;
  requestAnimationFrame(() => layer.querySelectorAll('.scrim, .sheet').forEach((e) => e.classList.add('show')));
}

function closeSheet() {
  const items = layer.querySelectorAll('.scrim, .sheet');
  if (!items.length) return;
  items.forEach((e) => e.classList.remove('show'));
  setTimeout(() => {
    if (!layer.querySelector('.show')) layer.innerHTML = '';
  }, 250);
}

let toastTimer = 0;
let toastUndo: (() => void) | undefined;
function toast(msg: string, action?: { label: string; run: () => void }) {
  toastUndo = action?.run;
  toastEl.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" data-action="toast-action">${esc(action.label)}</button>` : ''}`;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), action ? 5000 : 2200);
}

// ---------- events ----------

document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  switch (a) {
    case 'tab': {
      const tab = el.dataset.tab as Tab;
      if (tab === state.tab) return scrollTop();
      scrollPos[state.tab] = pane.scrollTop;
      state.tab = tab;
      history.replaceState(null, '', `#${tab}`);
      pane.scrollTop = 0;
      render();
      pane.scrollTop = scrollPos[tab] ?? 0;
      return;
    }
    case 'to-top':
      return scrollTop();
    case 'new':
      return openEditor(null);
    case 'edit':
      return openEditor(el.dataset.id!);
    case 'back':
      return closeEditor();
    case 'save':
      return saveEditor();
    case 'delete':
      return confirmDelete();
    case 'confirm-delete':
      return doDelete();
    case 'close-sheet':
      return closeSheet();
    case 'freq': {
      const f = form();
      (f.elements.namedItem('frequency') as HTMLInputElement).value = el.dataset.freq!;
      f.querySelectorAll('[data-action="freq"]').forEach((b) => {
        b.classList.toggle('on', b === el);
        b.setAttribute('aria-checked', String(b === el));
      });
      return updatePreview();
    }
    case 'filter':
      state.filter = el.dataset.filter as Filter;
      return render();
    case 'month':
      state.cal = { y: Number(el.dataset.y), m: Number(el.dataset.m) };
      return render();
    case 'cal-step':
      state.cal = addMonths(state.cal.y, state.cal.m, Number(el.dataset.step));
      return render();
    case 'cal-today': {
      const t = parseDate(state.today);
      state.cal = { y: t.y, m: t.m };
      return render();
    }
    case 'theme':
      applyTheme(el.dataset.theme as store.Theme);
      return render();
    case 'enable-notif':
      return enableNotifications();
    case 'test-notif':
      return testNotification();
    case 'export':
      return exportBackup();
    case 'reload':
      if (state.editingId !== undefined) closeEditor(true);
      history.replaceState(null, '', `#${state.tab}`);
      return location.reload();
    case 'toast-action': {
      const run = toastUndo;
      toastUndo = undefined;
      toastEl.classList.remove('show');
      run?.();
      return;
    }
  }
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  saveEditor();
});

document.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.closest('#form')) updatePreview();
});

document.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.name === 'hasPrice') (sub.querySelector('#price-fields') as HTMLElement).hidden = !t.checked;
  if (t.name === 'hasRenewal') (sub.querySelector('#renewal-fields') as HTMLElement).hidden = !t.checked;
  if (t.closest('#form')) updatePreview();
  if (t.dataset.action === 'import' && t.files?.[0]) importBackup(t.files[0], t);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (layer.querySelector('.sheet')) closeSheet();
  else if (state.editingId !== undefined) closeEditor();
});

pane.addEventListener('scroll', () => (scrollPos[state.tab] = pane.scrollTop), { passive: true });

function scrollTop() {
  pane.scrollTo({ top: 0, behavior: 'smooth' });
}

window.addEventListener('popstate', () => {
  if (state.editingId !== undefined && !/^#(edit|new)/.test(location.hash)) {
    closeSheet();
    closeEditor(true);
  }
});

window.addEventListener('storage', (e) => {
  if (e.key === store.KEY) {
    state.payments = store.loadPayments();
    render();
  }
});

// Swipe back from the leading (right, in RTL) edge of the full-screen editor.
(() => {
  let startX = 0, startY = 0, dx = 0, tracking = false, decided = false, t0 = 0;
  sub.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    const r = sub.getBoundingClientRect();
    if (e.touches.length !== 1 || r.right - t.clientX > 28) return;
    tracking = true; decided = false; dx = 0; startX = t.clientX; startY = t.clientY; t0 = Date.now();
  }, { passive: true });
  sub.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const t = e.touches[0];
    const mx = startX - t.clientX; // moving left = going back in RTL
    const my = Math.abs(t.clientY - startY);
    if (!decided) {
      if (Math.abs(mx) < 8 && my < 8) return;
      decided = true;
      if (my > Math.abs(mx) || mx < 0) { tracking = false; return; }
      sub.style.transition = 'none';
    }
    dx = Math.max(0, mx);
    sub.style.transform = `translateX(${-dx}px)`;
    e.preventDefault();
  }, { passive: false });
  const end = () => {
    if (!tracking) return;
    tracking = false;
    const w = sub.clientWidth;
    const fast = dx > 40 && dx / Math.max(1, Date.now() - t0) > 0.5;
    sub.style.transition = 'transform .2s ease-out';
    if (dx > w * 0.33 || fast) {
      sub.style.transform = `translateX(${-w}px)`;
      setTimeout(() => closeEditor(), 180);
    } else {
      sub.style.transform = '';
    }
  };
  sub.addEventListener('touchend', end);
  sub.addEventListener('touchcancel', end);
})();

// ---------- backup ----------

function exportBackup() {
  const blob = new Blob([store.serialize(state.payments)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fixed-costs-${state.today}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('קובץ הגיבוי נשמר');
}

function importBackup(file: File, input: HTMLInputElement) {
  file.text().then((text) => {
    input.value = '';
    const list = store.parseStored(text);
    if (!list) return toast('הקובץ לא נראה כמו גיבוי של האפליקציה');
    openSheet(`
      <h3>לשחזר מהגיבוי?</h3>
      <p>${n(list.length)} תשלומים מהקובץ יחליפו את ${n(state.payments.length)} התשלומים שבמכשיר עכשיו.</p>
      <button class="btn btn-teal" type="button" data-action="confirm-import" data-testid="confirm-import">שחזור</button>
      <button class="btn btn-ghost" type="button" data-action="close-sheet">ביטול</button>`);
    layer.querySelector('[data-action="confirm-import"]')!.addEventListener('click', () => {
      const before = state.payments;
      closeSheet();
      commit(list, 'הגיבוי שוחזר', () => commit(before, 'השחזור בוטל'));
    });
  });
}

// ---------- reminders, notifications & badge ----------

function reminderText(r: Reminder): { title: string; body: string } {
  const when = r.days === 0 ? 'היום' : r.days === 1 ? 'מחר' : `ב־${prettyDate(r.date)}`;
  if (r.kind === 'charge') return { title: `${r.name} · ⁦${formatILS(r.amount!, true)}⁩`, body: `חיוב ${when}` };
  if (r.kind === 'price') return { title: `${r.name} מתייקר`, body: `${when}: מ־⁦${formatILS(r.from!, true)}⁩ ל־⁦${formatILS(r.to!, true)}⁩` };
  return { title: `${r.name}: חידוש חוזה`, body: `החוזה מתחדש או מסתיים ${when}` };
}

async function refreshReminders(notify = true) {
  const items = dueReminders(state.payments, state.today);
  try {
    if (items.length) await (navigator as any).setAppBadge?.(items.length);
    else await (navigator as any).clearAppBadge?.();
  } catch { /* badge not supported */ }
  if (!notify || !('Notification' in window) || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  const shown = store.loadNotified();
  for (const r of items) {
    if (shown[r.key]) continue;
    const { title, body } = reminderText(r);
    await reg.showNotification(title, {
      body, tag: r.key, lang: 'he', dir: 'rtl', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      data: { url: r.kind === 'charge' ? '/#calendar' : `/#edit/${r.paymentId}` },
    });
    shown[r.key] = state.today;
  }
  for (const [k, d] of Object.entries(shown)) if (d < addDaysStr(state.today, -60)) delete shown[k];
  store.saveNotified(shown);
}

function addDaysStr(s: string, days: number): string {
  const { y, m, d } = parseDate(s);
  const dt = new Date(y, m - 1, d + days);
  return todayString(dt);
}

async function enableNotifications() {
  // Called only from a button tap, as iOS requires.
  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') {
      toast('התזכורות הופעלו');
      await refreshReminders(true);
    } else toast('ההתראות לא אושרו');
  } catch {
    toast('לא ניתן להפעיל התראות כאן');
  }
  render();
}

async function testNotification() {
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification('קבועים', { body: 'כך תיראה תזכורת לפני חיוב.', tag: 'test', lang: 'he', dir: 'rtl', icon: '/icons/icon-192.png', data: { url: '/#overview' } });
}

// ---------- connection, freshness & updates ----------

function updateOnline() {
  $('offline').hidden = navigator.onLine;
}
window.addEventListener('online', () => { updateOnline(); checkVersion(); });
window.addEventListener('offline', updateOnline);

function refreshDay() {
  const t = todayString();
  if (t !== state.today) {
    state.today = t;
    render();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  refreshDay();
  state.payments = store.loadPayments();
  render();
  refreshReminders(true);
  checkVersion();
});

let latestBuild = '';
async function checkVersion() {
  if (!navigator.onLine) return;
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const { build } = await res.json();
    if (build && build !== window.BUILD_ID) {
      latestBuild = build;
      state.updateWaiting = true;
      maybeApplyUpdate();
    }
  } catch { /* offline or blocked: try again later */ }
}

function busy(): boolean {
  return state.editingId !== undefined || !!layer.querySelector('.sheet');
}

function maybeApplyUpdate() {
  const tried = sessionStorage.getItem('reloadedFor') === latestBuild;
  if (!busy() && !tried) {
    sessionStorage.setItem('reloadedFor', latestBuild);
    history.replaceState(null, '', `#${state.tab}`); // reload into the current tab, not a closed editor
    location.reload();
  } else {
    $('update').hidden = false;
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate') routeTo(new URL(e.data.url, location.href).hash);
  });
}

function routeTo(hash: string) {
  const h = hash.replace(/^#/, '');
  if (h.startsWith('edit/')) {
    const id = decodeURIComponent(h.slice(5));
    if (state.editingId !== undefined) closeEditor();
    return openEditor(id);
  }
  if (h === 'overview' || h === 'calendar' || h === 'settings') {
    if (state.editingId !== undefined) closeEditor();
    state.tab = h;
    history.replaceState(null, '', `#${h}`);
    render();
  }
}

// ---------- start ----------

applyTheme(state.theme);
updateOnline();
const startHash = location.hash.replace(/^#/, '');
if (startHash === 'calendar' || startHash === 'settings') state.tab = startHash;
history.replaceState(null, '', `#${state.tab}`);
render();
if (startHash.startsWith('edit/')) openEditor(decodeURIComponent(startHash.slice(5)));
refreshReminders(true);
checkVersion();
setInterval(() => { refreshDay(); checkVersion(); }, 5 * 60_000);
