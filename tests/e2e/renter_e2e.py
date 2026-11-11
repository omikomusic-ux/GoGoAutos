import asyncio, http.server, threading, socketserver, functools, json, sys, base64
from playwright.async_api import async_playwright
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory='/home/claude/gogoautos'); H.log_message = lambda *a, **k: None
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(('127.0.0.1', 8791), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
PAY = sys.argv[1] == 'pay' if len(sys.argv) > 1 else False
S = {'signed': False, 'calls': [], 'docs': {}}
def portal(action, body):
    S['calls'].append(action)
    renter = {'id': 'r1', 'name': 'Ana Diaz', 'phone': '7135551234', 'car_id': 'c1', 'contract_start': '2026-11-02', 'contract_end': '2026-11-30', 'weekly_rent': 400, 'protection_fee': 126, 'deposit': 600, 'active': True}
    base = {'renter': renter, 'car': {'id': 'c1', 'make': 'Toyota', 'model': 'Corolla', 'year': 2015, 'color': 'Blue', 'plate': 'ABC123'},
            'operator': {'name': 'Carlos Fleet LLC', 'phone': '713-555-0000'}, 'pay_enabled': PAY, 'payments': []}
    if action == 'login':
        if body.get('pin') != '1234': return 401, {'error': 'Invalid phone or PIN'}
        return 200, {**base, 'token': 'tok', 'contract_signed': S['signed'], 'docs': {}}
    if action == 'data': return 200, base
    if action == 'docs': return 200, {'docs': S['docs']}
    if action == 'sign-contract':
        assert body['signature'].startswith('data:image/png;base64,'); S['signed'] = True; S['sig_len'] = len(body['signature']); return 200, {'ok': True}
    if action == 'upload-doc': S['docs'][body['docType']] = {'uploaded': True, 'url': None}; return 200, {'ok': True}
    return 400, {'error': 'bad'}
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 390, 'height': 844}); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: print('console:', m.text) if m.type in ('error','warning') else None)
        async def route(r):
            u = r.request.url
            if '/functions/v1/renter-portal' in u:
                st, d = portal(**{'action': json.loads(r.request.post_data)['action'], 'body': json.loads(r.request.post_data)})
                return await r.fulfill(status=st, content_type='application/json', body=json.dumps(d), headers={'access-control-allow-origin': '*'})
            if '/functions/v1/create-checkout' in u:
                S['calls'].append('checkout'); return await r.fulfill(status=200, content_type='application/json', body=json.dumps({'url': 'http://127.0.0.1:8791/404.html'}), headers={'access-control-allow-origin': '*'})
            if u.startswith('http://127.0.0.1'): return await r.continue_()
            await r.abort()
        await pg.route('**/*', route)
        await pg.goto('http://127.0.0.1:8791/renter.html'); await pg.wait_for_timeout(600)
        await pg.fill('#rp-phone', '713-555-1234'); await pg.click('text=Continue'); await pg.wait_for_timeout(300)
        for k in '9999': await pg.click(f'.rp-key:text-is("{k}")')
        await pg.wait_for_timeout(700)
        print('wrong PIN message shown:', 'Incorrect' in await pg.inner_text('#rp-main'))
        for k in '1234': await pg.click(f'.rp-key:text-is("{k}")')
        await pg.wait_for_timeout(900)
        print('errs', errs, 'sigscreen', await pg.evaluate("document.getElementById('signature-screen').className + '|' + getComputedStyle(document.getElementById('signature-screen')).display + '|' + document.getElementById('sig-scroll-area').innerText.length"));print('calls', S['calls'], 'pin state', await pg.evaluate('rpState.pin'), await pg.evaluate('rpState.authed'))
        txt = await pg.inner_text('#signature-screen'); await pg.screenshot(path='r_contract.png')
        print('contract page shows operator:', 'Carlos Fleet LLC' in txt, '| shows GOGO Fleet as owner:', 'between GOGO Fleet' in txt)
        # draw signature
        await pg.screenshot(path='r_contract2.png', full_page=False)
        print('pos', await pg.evaluate("(()=>{const e=document.getElementById('signature-screen');const c=getComputedStyle(e);return [c.position,c.zIndex,e.parentElement.tagName+'#'+e.parentElement.id, e.getBoundingClientRect().top]})()"))
        print('canvas box', await pg.locator('#sig-canvas').bounding_box())
        await pg.locator('#sig-canvas').scroll_into_view_if_needed(); box = await pg.locator('#sig-canvas').bounding_box()
        await pg.mouse.move(box['x']+30, box['y']+80); await pg.mouse.down()
        for i in range(12): await pg.mouse.move(box['x']+30+i*20, box['y']+60+(i%3)*25)
        await pg.mouse.up()
        print('DBG', box, await pg.evaluate("[sigHasContent, sigDrawing, (()=>{const b=document.getElementById('sig-canvas').getBoundingClientRect();const e=document.elementFromPoint(b.x+50,b.y+80);return e&&(e.tagName+'#'+e.id+'.'+e.className)})()]"))
        await pg.click('#sig-submit-btn'); await pg.wait_for_timeout(1200)
        print('signature sent:', S.get('signed'), 'len', S.get('sig_len'))
        await pg.screenshot(path='r_home.png'); home = await pg.inner_text('#rp-main')
        print('Pay Now visible:', 'Pay Now' in home, '(expected', PAY, ')| direct-pay message:', 'Pay your operator directly' in home)
        if PAY:
            await pg.click('#rp-stripe-btn'); await pg.wait_for_timeout(800); print('checkout called:', 'checkout' in S['calls'])
        await pg.click('[data-rptab=docs]'); await pg.wait_for_timeout(400)
        open('/tmp/x.jpg','wb').write(bytes([0xff,0xd8,0xff,0xe0])+b'1'*500)
        await pg.locator('input[type=file]').first.set_input_files('/tmp/x.jpg'); await pg.wait_for_timeout(1200)
        print('doc upload sent:', 'upload-doc' in S['calls'])
        await pg.screenshot(path='r_docs.png')
        print('page errors:', errs)
        await b.close()
asyncio.run(main()); srv.shutdown()
