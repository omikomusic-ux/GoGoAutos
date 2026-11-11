import asyncio, http.server, threading, socketserver, functools, json, re
from playwright.async_api import async_playwright
socketserver.TCPServer.allow_reuse_address = True
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory='/home/claude/gogoautos'); H.log_message = lambda *a, **k: None
srv = socketserver.TCPServer(('127.0.0.1', 8793), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
UID = '11111111-1111-1111-1111-111111111111'
user = {'id': UID, 'email': 'omar@test.com', 'user_metadata': {'role': 'owner'}}
session = {'access_token': 'a.b.c', 'refresh_token': 'r', 'expires_at': 4102444800, 'user': user}
team = [{'id': 't1', 'user_id': UID, 'owner_id': UID, 'role': 'owner', 'name': 'Omar', 'email': 'omar@test.com', 'biz_name': 'Carlos Fleet LLC', 'tos_accepted': True, 'contact_phone': '713-555-0000'}]
cars = []; BILL = {'plan': 'starter', 'plan_label': 'Starter', 'status': 'trialing', 'trial_days_left': 14, 'cars_used': 0, 'cars_limit': 5, 'has_subscription': False, 'payouts_enabled': False, 'has_connect_account': False, 'is_owner': True}
calls = []
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width': 390, 'height': 844})
        await ctx.add_init_script(f"localStorage.setItem('gogoautos-session', {json.dumps(json.dumps(session))}); localStorage.setItem('gogo-tos-{UID}','accepted');")
        pg = await ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url; m = r.request.method
            cors = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*'}
            if m == 'OPTIONS': return await r.fulfill(status=204, headers=cors)
            if '/functions/v1/owner-billing' in u:
                a = json.loads(r.request.post_data)['action']; calls.append(a)
                d = {'url': 'http://127.0.0.1:8793/404.html'} if a in ('checkout', 'connect-onboard') else dict(BILL, cars_used=len(cars))
                if a == 'connect-status': d = {'payouts_enabled': False}
                return await r.fulfill(status=200, content_type='application/json', body=json.dumps(d), headers=cors)
            if '/auth/v1/user' in u: return await r.fulfill(status=200, content_type='application/json', body=json.dumps(user), headers=cors)
            if '/rest/v1/' in u:
                t = re.search(r'/rest/v1/(\w+)', u).group(1)
                if m == 'POST' and t == 'cars':
                    return await r.fulfill(status=403, content_type='application/json', body=json.dumps({'message': 'PLAN_LIMIT: Your starter plan includes 5 vehicles. Upgrade in Team → Plan & Billing to add more.'}), headers=cors)
                rows = team if t == 'team_members' else []
                return await r.fulfill(status=200, content_type='application/json', body=json.dumps(rows), headers=cors)
            if u.startswith('http://127.0.0.1'): return await r.continue_()
            await r.abort()
        await pg.route('**/*', route)
        await pg.goto('http://127.0.0.1:8793/app.html'); await pg.wait_for_timeout(2500)
        await pg.screenshot(path='o_dash.png')
        txt = await pg.inner_text('#main-content'); print('dashboard has Get started:', 'Get started' in txt, '| payment-banner old text gone:', 'No payment method on file' not in txt)
        await pg.evaluate("navigate('team')"); await pg.wait_for_timeout(1200)
        await pg.screenshot(path='o_team.png', full_page=False)
        t = await pg.inner_text('#main-content'); print('team shows plan card:', 'Starter plan' in t and 'day' in t, '| Choose buttons:', t.count('Choose'), '| Set up payouts:', 'Set up payouts' in t)
        await pg.click('text=Set up payouts'); await pg.wait_for_timeout(600); print('connect-onboard called:', 'connect-onboard' in calls)
        await pg.goto('http://127.0.0.1:8793/app.html'); await pg.wait_for_timeout(2000)
        await pg.evaluate("openSheet('add-car')"); await pg.wait_for_timeout(500)
        for f, v in [('f-year', '2015'), ('f-make', 'Toyota'), ('f-model', 'Corolla'), ('f-plate', 'ABC123'), ('f-price', '4000')]:
            if await pg.locator('#' + f).count(): await pg.fill('#' + f, v)
        await pg.evaluate("submitAddCar()"); await pg.wait_for_timeout(1000)
        toast = await pg.evaluate("document.querySelector('.toast')?.textContent || ''"); print('limit toast:', toast[:90], '| now on', await pg.evaluate('currentPage'))
        print('page errors:', errs)
        await b.close()
asyncio.run(main()); srv.shutdown()
