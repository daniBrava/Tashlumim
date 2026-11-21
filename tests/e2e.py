"""End-to-end checks against the project's pre-ship checklist.

Run:  node build.mjs && python3 tests/e2e.py
Serves a copy of dist/ at the site root (as on a real host), freezes the clock at 11 Nov 2026,
and blocks every request that isn't to the local server.
"""
import datetime as dt
import functools
import http.server
import json
import os
import shutil
import socketserver
import sys
import tempfile
import threading
from zoneinfo import ZoneInfo

from playwright.sync_api import sync_playwright, expect

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, '..', 'dist')
SHOTS = os.environ.get('SHOTS', os.path.join(HERE, '..', 'screenshots'))
os.makedirs(SHOTS, exist_ok=True)
NOW = dt.datetime(2026, 11, 11, 10, 0, tzinfo=ZoneInfo('Asia/Jerusalem'))
IPHONE_UA = ('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
             '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')

results = []


def check(label, actual, expected):
    ok = actual == expected
    results.append(ok)
    print(('PASS ' if ok else 'FAIL ') + f'{label}: got {actual!r}' + ('' if ok else f', expected {expected!r}'))


class Quiet(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.webmanifest': 'application/manifest+json', '.js': 'text/javascript'}

    def end_headers(self):
        if self.path.startswith('/version.json') or self.path in ('/', '/index.html', '/sw.js'):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *a):
        pass


def tid(page, t):
    return page.get_by_test_id(t)


def text(page, t):
    return ' '.join(tid(page, t).first.inner_text().split())


def set_date(page, test_id, value):
    tid(page, test_id).fill(value)


def add_payment(page, name, amount, freq, date):
    page.locator('[data-action="new"]').first.click()
    expect(tid(page, 'input-name')).to_be_visible()
    tid(page, 'input-name').fill(name)
    tid(page, 'input-amount').fill(str(amount))
    tid(page, f'freq-{freq}').click()
    set_date(page, 'input-date', date)
    tid(page, 'editor-save').click()
    expect(page.locator('#sub')).to_be_hidden()


def rect(page, selector):
    return page.eval_on_selector(selector, 'e => { const r = e.getBoundingClientRect(); return {top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width}; }')


def main():
    site = tempfile.mkdtemp()
    shutil.copytree(DIST, site, dirs_exist_ok=True)
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=site))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{srv.server_address[1]}/'
    external = []

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])

        def new_ctx(**kw):
            opts = dict(viewport={'width': 393, 'height': 852}, device_scale_factor=2, timezone_id='Asia/Jerusalem',
                        locale='he-IL', is_mobile=True, has_touch=True)
            opts.update(kw)
            ctx = browser.new_context(**opts)

            def gate(route):
                if route.request.url.startswith(url):
                    route.continue_()
                else:
                    external.append(route.request.url)
                    route.abort()
            ctx.route('**/*', gate)
            return ctx

        def open_page(ctx, path=''):
            page = ctx.new_page()
            page.clock.set_fixed_time(NOW)
            page.goto(url + path)
            expect(page.locator('#title')).not_to_be_empty(timeout=15000)
            return page

        ctx = new_ctx()
        ctx.add_init_script("""
          window.__badge = null;
          Object.defineProperty(navigator, 'setAppBadge', { value: (n) => { window.__badge = n; return Promise.resolve(); }, configurable: true });
          Object.defineProperty(navigator, 'clearAppBadge', { value: () => { window.__badge = 0; return Promise.resolve(); }, configurable: true });
        """)
        page = open_page(ctx)

        # ---- 1. install as an app ----
        head = page.evaluate("""() => ({
          dir: document.documentElement.dir, lang: document.documentElement.lang,
          viewport: document.querySelector('meta[name=viewport]').content,
          capable: !!document.querySelector('meta[name=apple-mobile-web-app-capable]') && !!document.querySelector('meta[name=mobile-web-app-capable]'),
          title: document.querySelector('meta[name=apple-mobile-web-app-title]').content,
          themes: [...document.querySelectorAll('meta[name=theme-color]')].map(m => m.media),
          touchIcon: document.querySelector('link[rel=apple-touch-icon]').getAttribute('href'),
        })""")
        check('html lang/dir', (head['lang'], head['dir']), ('he', 'rtl'))
        check('viewport', head['viewport'], 'width=device-width, initial-scale=1, viewport-fit=cover')
        check('web-app-capable metas', head['capable'], True)
        check('home-screen title', head['title'], 'קבועים')
        check('theme-color light+dark', head['themes'], ['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)'])
        man = page.evaluate("fetch('/manifest.webmanifest').then(r => r.json())")
        check('manifest fields', (man['short_name'], man['lang'], man['dir'], man['start_url'], man['display']), ('קבועים', 'he', 'rtl', '/', 'standalone'))
        sizes = page.evaluate("""async () => { const out = {};
          for (const s of ['/icons/icon-512.png', '/icons/apple-touch-icon.png']) {
            const b = await (await fetch(s)).blob(); const i = await createImageBitmap(b); out[s] = [i.width, i.height]; }
          return out; }""")
        check('512px icon + 180px touch icon', sizes, {'/icons/icon-512.png': [512, 512], '/icons/apple-touch-icon.png': [180, 180]})

        # ---- 2. no zoom ----
        css = page.evaluate("""() => ({
          touch: getComputedStyle(document.body).touchAction,
          tap: getComputedStyle(document.body).webkitTapHighlightColor,
          paneOverscroll: getComputedStyle(document.getElementById('pane')).overscrollBehaviorY,
        })""")
        check('touch-action manipulation', css['touch'], 'manipulation')
        check('tap highlight transparent', css['tap'], 'rgba(0, 0, 0, 0)')
        check('inner scroller overscroll contain', css['paneOverscroll'], 'contain')

        # ---- data: the example from the brief ----
        page.screenshot(path=f'{SHOTS}/01-empty.png')
        check('empty: monthly cost', text(page, 'monthly-cost'), '₪0')
        add_payment(page, 'שכירות', 5000, 'monthly', '2026-11-01')
        add_payment(page, 'ביטוח רכב', 1200, 'yearly', '2026-03-10')
        add_payment(page, 'חדר כושר', 300, 'quarterly', '2026-08-05')
        check('monthly cost = 5000 + 1200/12 + 300/3', text(page, 'monthly-cost'), '₪5,200')
        check('charged in November = rent + gym', text(page, 'month-total'), '₪5,300')
        check('yearly row: full amount, freq, next date, monthly share',
              ' '.join(tid(page, 'row-ביטוח רכב').inner_text().split()), 'ב ביטוח רכב שנתי · הבא 10 במרץ 2027 ₪1,200 ₪100 לחודש')
        check('quarterly row', ' '.join(tid(page, 'row-חדר כושר').inner_text().split()), 'ח חדר כושר רבעוני · הבא 5 בפברואר 2027 ₪300 ₪100 לחודש')
        check('money isolated LTR in RTL text', page.eval_on_selector('[data-testid="monthly-cost"] bdi', 'e => e.dir'), 'ltr')
        check('tabular numbers', page.eval_on_selector('[data-testid="monthly-cost"] bdi', 'e => getComputedStyle(e).fontVariantNumeric'), 'tabular-nums')
        check('toast after save', page.locator('#toast').inner_text(), 'התשלום נוסף')
        page.wait_for_timeout(2500)

        # ---- calendar ----
        page.locator('.tab[data-tab="calendar"]').click()
        check('calendar Nov total', text(page, 'cal-total'), '₪5,300 ב־2 חיובים')
        check('circle on 1 Nov', text(page, 'charge-day-1'), '5,000')
        check('circle on 5 Nov', text(page, 'charge-day-5'), '300')
        check('Sunday is the rightmost column (RTL)', rect(page, '.wd:nth-child(1)')['left'] > rect(page, '.wd:nth-child(7)')['left'], True)
        page.screenshot(path=f'{SHOTS}/03-calendar-nov.png')
        page.locator('[data-action="month"][data-y="2027"][data-m="3"]').click()
        check('calendar March 2027 via month chip', text(page, 'cal-month'), 'מרץ 2027')
        check('March: full yearly charge', text(page, 'cal-total'), '₪6,200 ב־2 חיובים')
        check('circle on 10 Mar', text(page, 'charge-day-10'), '1,200')
        chips_sb = page.eval_on_selector('[data-testid="month-chips"]', 'e => [getComputedStyle(e).overflowX, e.offsetHeight - e.clientHeight]')
        check('chip strip scrolls with no visible scrollbar', chips_sb, ['auto', 0])
        page.screenshot(path=f'{SHOTS}/04-calendar-mar.png')
        tid(page, 'next-month').click()
        check('April: no insurance', text(page, 'cal-total'), '₪5,000 ב־1 חיוב')

        # ---- edit updates both totals and the calendar ----
        page.locator('.tab[data-tab="overview"]').click()
        tid(page, 'row-ביטוח רכב').click()
        tid(page, 'input-amount').fill('2400')
        check('editor preview', text(page, 'editor-preview'), 'נספר כ־₪200 בחודש · החיוב הבא 10 במרץ 2027')
        page.screenshot(path=f'{SHOTS}/05-edit.png')
        tid(page, 'editor-save').click()
        expect(page.locator('#sub')).to_be_hidden()
        check('monthly after edit', text(page, 'monthly-cost'), '₪5,300')
        page.locator('.tab[data-tab="calendar"]').click()
        page.locator('[data-action="month"][data-y="2027"][data-m="3"]').click()
        check('calendar March after edit', text(page, 'cal-total'), '₪7,400 ב־2 חיובים')

        # ---- known price change + heads-up ----
        page.locator('.tab[data-tab="overview"]').click()
        tid(page, 'row-שכירות').click()
        tid(page, 'switch-price').check()
        set_date(page, 'input-price-date', '2026-12-01')
        tid(page, 'input-price-amount').fill('5500')
        tid(page, 'editor-save').click()
        expect(page.locator('#sub')).to_be_hidden()
        check('price heads-up', 'שכירות מתייקר מ־₪5,000 ל־₪5,500' in text(page, 'heads-up'), True)
        check('monthly uses today\'s price', text(page, 'monthly-cost'), '₪5,300')
        page.wait_for_timeout(2500)
        page.screenshot(path=f'{SHOTS}/02-overview.png')

        # ---- 5. title tap → top; scroll restored after editing ----
        for i in range(9):
            add_payment(page, f'מנוי {i + 1}', 20 + i, 'monthly', '2026-11-20')
        page.wait_for_timeout(2500)
        check('page itself never scrolls', page.evaluate('document.scrollingElement.scrollHeight <= innerHeight && getComputedStyle(document.body).overflow'), 'hidden')
        page.eval_on_selector('#pane', 'e => e.scrollTop = 400')
        page.locator('#title').click()
        page.wait_for_function('document.getElementById("pane").scrollTop === 0', timeout=3000)
        check('title tap scrolls to top', page.eval_on_selector('#pane', 'e => e.scrollTop'), 0)
        page.eval_on_selector('#pane', 'e => e.scrollTop = 420')
        before = page.eval_on_selector('#pane', 'e => e.scrollTop')
        tid(page, 'row-מנוי 9').click()
        tid(page, 'input-amount').fill('99')
        tid(page, 'editor-save').click()
        expect(page.locator('#sub')).to_be_hidden()
        check('same scroll position after editing', page.eval_on_selector('#pane', 'e => e.scrollTop'), before)

        # swipe back from the right (leading) edge
        tid(page, 'row-מנוי 8').click()
        expect(tid(page, 'input-name')).to_be_visible()
        page.wait_for_timeout(350)
        page.evaluate("""() => {
          const el = document.getElementById('sub'); const r = el.getBoundingClientRect();
          const mk = (x) => new Touch({identifier: 1, target: el, clientX: x, clientY: 400});
          const fire = (type, x) => el.dispatchEvent(new TouchEvent(type, {touches: type === 'touchend' ? [] : [mk(x)], changedTouches: [mk(x)], bubbles: true, cancelable: true}));
          fire('touchstart', r.right - 6); for (let x = r.right - 20; x > r.right - 260; x -= 30) fire('touchmove', x); fire('touchend', r.right - 260);
        }""")
        expect(page.locator('#sub')).to_be_hidden(timeout=3000)
        check('swipe back closes editor', page.locator('#sub').is_hidden(), True)
        check('swipe back keeps scroll position', page.eval_on_selector('#pane', 'e => e.scrollTop'), before)

        # ---- 4. confirm card + toast above the tab bar ----
        tid(page, 'row-מנוי 1').click()
        tid(page, 'editor-delete').click()
        expect(tid(page, 'sheet')).to_be_visible()
        page.wait_for_timeout(400)
        check('sheet lives in the layer after the tab bar',
              page.evaluate("document.querySelector('.sheet').parentElement.id === 'layer' && document.querySelector('nav.tabbar').compareDocumentPosition(document.getElementById('layer')) === 4"), True)
        page.locator('.scrim').click(position={'x': 50, 'y': 50})
        expect(page.locator('.sheet')).to_have_count(0)
        check('tapping the dim background closes', page.locator('.sheet').count(), 0)
        tid(page, 'editor-delete').click()
        tid(page, 'confirm-delete').click()
        expect(page.locator('#sub')).to_be_hidden()
        check('deleted', tid(page, 'row-מנוי 1').count(), 0)
        tb = rect(page, 'nav.tabbar')
        ts = rect(page, '#toast')
        check('toast sits above the tab bar', ts['bottom'] <= tb['top'], True)
        check('toast has undo', page.locator('#toast button').inner_text(), 'ביטול')
        page.locator('#toast button').click()
        check('undo restores', tid(page, 'row-מנוי 1').count(), 1)

        # validation
        page.locator('[data-action="new"]').first.click()
        tid(page, 'editor-save').click()
        check('validation', text(page, 'editor-error'), 'צריך לתת שם לתשלום.')
        tid(page, 'editor-cancel').click()
        expect(page.locator('#sub')).to_be_hidden()

        # ---- 8. notifications & badge (desktop Chrome = notifications allowed directly) ----
        page.locator('.tab[data-tab="settings"]').click()
        check('permission asked only from a button', tid(page, 'enable-notif').inner_text(), 'הפעלת תזכורות')
        ctx.grant_permissions(['notifications'], origin=url[:-1])  # stands in for the user tapping "Allow"
        tid(page, 'enable-notif').click()
        expect(tid(page, 'notif')).to_contain_text('תזכורות פעילות')
        page.wait_for_timeout(800)
        notes = page.evaluate("navigator.serviceWorker.ready.then(r => r.getNotifications()).then(ns => ns.map(n => n.title + ' | ' + n.body))")
        check('reminder for gym? (no: gym next is Feb) · price change in 20 days (no: >7)', notes, [])
        check('badge count (nothing within 1–7 days on 11 Nov)', page.evaluate('window.__badge'), 0)
        # Move the clock to 30 Nov: rent charged 1 Dec (tomorrow) and rises to 5,500 that day.
        page.clock.set_fixed_time(dt.datetime(2026, 11, 30, 9, 0, tzinfo=ZoneInfo('Asia/Jerusalem')))
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        page.wait_for_timeout(1000)
        notes = page.evaluate("navigator.serviceWorker.ready.then(r => r.getNotifications()).then(ns => ns.map(n => n.title + ' | ' + n.body).sort())")
        check('notifications on 30 Nov', notes, ['שכירות · ⁦₪5,500⁩ | חיוב מחר', 'שכירות מתייקר | מחר: מ־⁦₪5,000⁩ ל־⁦₪5,500⁩'])
        check('badge on app icon', page.evaluate('window.__badge'), 2)
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        page.wait_for_timeout(500)
        check('no duplicate notifications', page.evaluate("navigator.serviceWorker.ready.then(r => r.getNotifications()).then(ns => ns.length)"), 2)
        page.clock.set_fixed_time(NOW)
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")

        # ---- 6. dark mode choice ----
        page.locator('[data-action="theme"][data-theme="dark"]').click()
        check('data-theme dark', page.evaluate('document.documentElement.dataset.theme'), 'dark')
        check('dark background', page.evaluate("getComputedStyle(document.body).backgroundColor"), 'rgb(30, 25, 22)')
        page.screenshot(path=f'{SHOTS}/07-settings-dark.png')
        page.locator('.tab[data-tab="overview"]').click()
        page.screenshot(path=f'{SHOTS}/08-overview-dark.png')

        # ---- persistence: close and reopen ----
        page.close()
        page = open_page(ctx)
        check('theme kept after reopen', page.evaluate('document.documentElement.dataset.theme'), 'dark')
        check('data kept after reopen', text(page, 'monthly-cost'), '₪5,587')
        page.locator('.tab[data-tab="settings"]').click()
        page.locator('[data-action="theme"][data-theme="device"]').click()
        check('device theme clears data-theme', page.evaluate('document.documentElement.dataset.theme || null'), None)
        page.locator('.tab[data-tab="overview"]').click()

        # ---- 7. offline (airplane mode) ----
        page.wait_for_function('navigator.serviceWorker.controller !== null', timeout=10000)
        ctx.set_offline(True)
        page.close()
        page = open_page(ctx)
        check('opens offline from the service worker', text(page, 'monthly-cost'), '₪5,587')
        check('"no connection" bar', page.locator('#offline').is_visible(), True)
        add_payment(page, 'חניה', 250, 'monthly', '2026-11-15')
        check('edits work offline', text(page, 'monthly-cost'), '₪5,837')
        check('sync status line', page.locator('#sync').inner_text().startswith('נשמר במכשיר'), True)
        page.screenshot(path=f'{SHOTS}/09-offline.png')
        ctx.set_offline(False)
        page.evaluate("window.dispatchEvent(new Event('online'))")
        expect(page.locator('#offline')).to_be_hidden()

        # ---- new version arrives without reinstalling ----
        old_build = page.evaluate('window.BUILD_ID')
        new_build = 'test-' + old_build
        idx = os.path.join(site, 'index.html')
        with open(idx, encoding='utf8') as f:
            html = f.read()
        with open(idx, 'w', encoding='utf8') as f:
            f.write(html.replace(f'window.BUILD_ID = "{old_build}"', f'window.BUILD_ID = "{new_build}"'))
        with open(os.path.join(site, 'version.json'), 'w') as f:
            json.dump({'build': new_build}, f)
        # while editing: show the button, don't reload
        tid(page, 'row-חניה').click()
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        expect(page.locator('#update')).to_be_visible(timeout=5000)
        check('editing → "new version · refresh" button', page.locator('#update').inner_text(), 'גרסה חדשה · רענון')
        page.screenshot(path=f'{SHOTS}/10-update-button.png')
        # leave the editor → nothing being edited → reloads by itself
        with page.expect_navigation(timeout=10000):
            tid(page, 'editor-cancel').click()
        page.wait_for_function('window.BUILD_ID !== undefined', timeout=10000)
        expect(page.locator('#title')).not_to_be_empty()
        check('reloaded into the new version', page.evaluate('window.BUILD_ID'), new_build)
        check('data intact after update', text(page, 'monthly-cost'), '₪5,837')
        check('reload lands on the tab, editor closed', (page.locator('#sub').is_hidden(), page.evaluate('location.hash')), (True, '#overview'))

        # ---- small screen (390×700): pop-ups fit and sit above the tab bar ----
        page.set_viewport_size({'width': 390, 'height': 700})
        tid(page, 'row-חניה').click()
        tid(page, 'editor-delete').click()
        page.wait_for_timeout(400)
        sh = rect(page, '.sheet')
        check('sheet fully on screen at 390×700', sh['top'] >= 0 and sh['bottom'] <= 700, True)
        page.screenshot(path=f'{SHOTS}/06-confirm-390x700.png')
        page.locator('.scrim').click(position={'x': 30, 'y': 30})
        tid(page, 'editor-cancel').click()
        expect(page.locator('#sub')).to_be_hidden()
        page.screenshot(path=f'{SHOTS}/11-overview-390x700.png')
        inputs = page.evaluate("[...document.querySelectorAll('input, select, textarea')].map(e => parseFloat(getComputedStyle(e).fontSize)).every(s => s >= 16)")
        check('all inputs ≥ 16px (no zoom on focus)', inputs, True)
        small = page.evaluate("""() => [...document.querySelectorAll('button, .chip, label.btn')].filter(e => e.offsetParent && !e.closest('.alerts'))
            .map(e => e.getBoundingClientRect()).filter(r => r.height < 40 && r.width > 0).length""")
        check('tap targets ≥ 40px', small, 0)
        page.close()
        ctx.close()

        # ---- iPhone Safari, not yet on the home screen: explain how to add ----
        ictx = new_ctx(user_agent=IPHONE_UA)
        ip = open_page(ictx, '#settings')
        check('iPhone (Safari tab): install explanation', 'הוספה למסך הבית' in text(ip, 'install-help'), True)
        check('no permission button before install', ip.locator('[data-testid="enable-notif"]').count(), 0)
        ip.screenshot(path=f'{SHOTS}/12-install-help.png')
        ictx.close()

        # ---- import from the earlier HTML prototype's storage ----
        mctx = new_ctx()
        mctx.add_init_script("""if (!sessionStorage.getItem('seeded')) {
            localStorage.setItem('periodicPayments', JSON.stringify([{name:'Netflix',amount:60,frequency:'monthly'},{name:'ביטוח דירה',amount:1200,frequency:'annually'}]));
            sessionStorage.setItem('seeded','1'); }""")
        mp = open_page(mctx)
        check('prototype data imported', text(mp, 'monthly-cost'), '₪160')
        mctx.close()
        browser.close()

    srv.shutdown()
    check('no requests left the device', external, [])
    print(f'\n{sum(results)}/{len(results)} checks passed')
    sys.exit(0 if all(results) else 1)


if __name__ == '__main__':
    main()
