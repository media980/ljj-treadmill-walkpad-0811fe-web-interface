// UI smoke test: index.html in Chromium with a fake navigator.bluetooth
// simulating a FitShow treadmill (RUNimon FS-E30107).
// Nécessite Playwright : npm i -D playwright (ou installé globalement),
// puis : npm run test:ui
'use strict';
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };

// Simulateur injecté dans la page (avant les scripts de l'application)
function installFakeBluetooth() {
  const cs = b => b.slice(1).reduce((a, x) => a ^ x, 0);
  const frame = (...b) => Uint8Array.from([...b, cs(b), 0x03]);
  const dev = { code: 0, speed: 0, countdown: 0 };
  window.__tx = [];
  let notifyCb = null;
  const notify = bytes => setTimeout(() => notifyCb && notifyCb({ target: { value: new DataView(bytes.buffer) } }), 30);
  const onWrite = f => {
    const b = [...f];
    window.__tx.push(b.map(x => x.toString(16).padStart(2, '0')).join(' '));
    if (b[1] === 0x51) {
      if (dev.code === 3 || dev.code === 4) notify(frame(0x02, 0x51, dev.code, dev.speed, 0, 5, 0, 1, 0, 2, 0, 0, 0, 0, 0));
      else if (dev.code === 2) notify(frame(0x02, 0x51, 0x02, dev.countdown));
      else notify(frame(0x02, 0x51, dev.code));
    } else if (b[1] === 0x50 && b[2] === 0x02) notify(frame(0x02, 0x50, 0x02, 60, 10, 0));
    else if (b[1] === 0x53 && b[2] === 0x01) {
      notify(frame(0x02, 0x53, 0x01));
      if (dev.code !== 2 && dev.code !== 3) {
        dev.code = 2; dev.countdown = 3;
        const iv = setInterval(() => {
          if (dev.code !== 2) return clearInterval(iv);
          if (--dev.countdown <= 0) { dev.code = 3; dev.speed = 10; clearInterval(iv); }
        }, 1000);
      }
    } else if (b[1] === 0x53 && b[2] === 0x02) {
      if (dev.code === 3) dev.speed = b[3];
      notify(frame(0x02, 0x53, 0x02, dev.code === 3 ? dev.speed : 0, 0));
    } else if (b[1] === 0x53 && b[2] === 0x03) {
      notify(frame(0x02, 0x53, 0x03));
      if (dev.code === 3) { dev.code = 4; setTimeout(() => { dev.code = 1; dev.speed = 0; }, 800); setTimeout(() => { dev.code = 0; }, 1600); }
      else if (dev.code === 2) dev.code = 0;
    }
  };
  const charRead = {
    startNotifications: async () => {},
    addEventListener: (_, cb) => { notifyCb = cb; },
  };
  const charWrite = { writeValue: async f => onWrite(f) };
  const device = {
    name: 'FS-E30107', id: 'fake',
    addEventListener: (ev, cb) => { if (ev === 'gattserverdisconnected') window.__dropConnection = cb; },
    gatt: {
      connected: true,
      connect: async () => ({ getPrimaryService: async () => ({ getCharacteristic: async u => (u.startsWith('0000fff1') ? charRead : charWrite) }) }),
      disconnect() {},
    },
  };
  window.__dev = dev;
  Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async () => device } });
}

async function main() {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.addInitScript(installFakeBluetooth);
  await page.goto(url);

  const statusText = () => page.textContent('#phase');
  const startCount = () => page.evaluate(() => window.__tx.filter(h => h.startsWith('02 53 01')).length);
  const waitPhase = (re, timeout = 10000) =>
    page.waitForFunction(src => new RegExp(src, 'i').test(document.querySelector('#phase').textContent), re.source, { timeout });
  const light = () => page.getAttribute('#conn', 'data-state');
  const errorPanelHidden = () => page.$eval('#error-panel', el => el.hidden);

  // Before connecting: light off, no log visible
  assert.equal(await light(), 'off');
  assert.equal(await errorPanelHidden(), true);

  await page.click('#btn-connect');
  await page.waitForFunction(() => !document.querySelector('#btn-start').disabled);
  await waitPhase(/stopped/);
  assert.equal(await light(), 'on');
  assert.match(await page.textContent('#conn-text'), /Connected/);
  assert.equal(await page.textContent('#btn-connect'), 'Disconnect');

  // Start at minimum speed (1.0 km/h)
  await page.click('[data-speed="1"]');
  await page.click('#btn-start');
  await waitPhase(/running/);
  assert.equal(await startCount(), 1);
  assert.equal(await page.textContent('#m-speed'), '1.0');
  assert.equal(await page.$eval('#btn-start', b => b.disabled), true, 'Start disabled while running');

  // Stop
  await page.click('#btn-stop');
  await waitPhase(/stopped/);
  assert.equal(await page.evaluate(() => window.__dev.speed), 0);

  // No spontaneous restart
  await page.waitForTimeout(3000);
  assert.equal(await page.evaluate(() => window.__dev.code), 0);
  assert.match(await statusText(), /stopped/i);
  assert.equal(await startCount(), 1);

  // Restart, stop via keyboard shortcut (Esc)
  await page.click('#btn-start');
  await waitPhase(/running/);
  assert.equal(await startCount(), 2);
  await page.keyboard.press('Escape');
  await waitPhase(/stopped/);

  // A normal session never shows the log
  const errLines = await page.$$eval('#log .err', els => els.map(e => e.textContent));
  assert.deepEqual(errLines, [], 'no error lines in BLE log');
  assert.equal(await errorPanelHidden(), true, 'log stays hidden without errors');

  // Unexpected connection loss: red light + error panel with log
  await page.evaluate(() => window.__dropConnection());
  assert.equal(await light(), 'err');
  assert.equal(await errorPanelHidden(), false);
  assert.match(await page.textContent('#error-msg'), /lost/);
  assert.equal(await page.$eval('#btn-start', b => b.disabled), true);

  assert.deepEqual(pageErrors, []);
  console.log('UI smoke test OK —', await statusText());
  await browser.close();
  server.close();
}

main().catch(e => { console.error(e); process.exit(1); });
