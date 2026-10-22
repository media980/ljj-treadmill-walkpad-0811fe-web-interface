'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../treadmill-core.js');
const { FakeClock, FitShowTreadmill, LjjTreadmill, frame, statusFull } = require('./mock-treadmill.js');

const { buildFrame, hex, isValidFrame, responseMatches, parseStatus, CMD, setSpeedCmd, TreadmillController } = core;

const START_HEX = '02 53 01 00 00 00 00 00 00 00 00 52 03';
const STOP_HEX = '02 53 03 50 03';
const isSpeed = h => h.startsWith('02 53 02');

// Contrôleur relié à un tapis simulé, heartbeat toutes les 500 ms
function setup(Device, { name = 'FS-E30107', strategy, deviceOpts } = {}) {
  const clock = new FakeClock();
  const device = new Device(clock, deviceOpts);
  const logs = [];
  const ctl = new TreadmillController({
    write: async f => device.write(f),
    log: (msg, cls) => logs.push({ msg, cls }),
    now: () => clock.now(),
    setTimeout: (f, ms) => clock.setTimeout(f, ms),
    clearTimeout: h => clock.clearTimeout(h),
  });
  device.notify = bytes => ctl.handleNotification(bytes);
  ctl.attach(name, strategy);
  const heartbeat = () => { ctl.tick(); clock.setTimeout(heartbeat, 500); };
  clock.setTimeout(heartbeat, 500);
  const run = ms => clock.advance(ms);
  const sent = () => device.received;
  const errors = () => logs.filter(l => l.cls === 'err');
  return { clock, device, ctl, logs, run, sent, errors };
}

// ---------- Trames ----------

test('frames: checksum and framing', () => {
  assert.equal(hex(buildFrame(CMD.STOP)), STOP_HEX);
  assert.equal(hex(buildFrame(CMD.STATUS)), '02 51 51 03');
  assert.equal(hex(buildFrame(CMD.WAKE)), '02 44 01 45 03');
  assert.equal(hex(buildFrame(CMD.START)), START_HEX);
  assert.equal(hex(buildFrame(setSpeedCmd(10, 0))), '02 53 02 0a 00 5b 03');
});

test('frames: validation rejects bad checksum / framing', () => {
  assert.ok(isValidFrame(Uint8Array.from([0x02, 0x53, 0x02, 0x00, 0x00, 0x51, 0x03])));
  assert.ok(!isValidFrame(Uint8Array.from([0x02, 0x53, 0x02, 0x00, 0x00, 0x52, 0x03])));
  assert.ok(!isValidFrame(Uint8Array.from([0x02, 0x53, 0x02, 0x00, 0x00, 0x51])));
  assert.ok(!isValidFrame(Uint8Array.from([0x02, 0x03])));
});

test('response matching ignores the reported (actual) speed', () => {
  const sent = setSpeedCmd(30, 0);
  // RUNimon : 02 53 02 00 00 51 03 (vitesse réelle 0) reste une réponse à SET_SPEED
  assert.ok(responseMatches(sent, [0x02, 0x53, 0x02, 0x00, 0x00, 0x51, 0x03]));
  assert.ok(!responseMatches(sent, [0x02, 0x53, 0x03, 0x50, 0x03]));
  assert.ok(responseMatches(CMD.STATUS, statusFull(3, 10)));
  assert.ok(responseMatches(CMD.START, [0x02, 0x53, 0x01, 0x52, 0x03]));
  assert.ok(!responseMatches(CMD.SPEED_INFO, [0x02, 0x50, 0x03, 0, 0, 0, 0x53, 0x03]));
});

test('status parsing: idle, countdown, running, LJJ running code 0x04', () => {
  assert.deepEqual(
    [parseStatus(frame(0x02, 0x51, 0x00)).moving, parseStatus(frame(0x02, 0x51, 0x00)).code], [false, 0]);
  const cd = parseStatus(frame(0x02, 0x51, 0x02, 0x03));
  assert.equal(cd.countdown, 3);
  assert.equal(cd.moving, false);
  const run = parseStatus(statusFull(3, 25, 300));
  assert.equal(run.moving, true);
  assert.equal(run.speed, 2.5);
  assert.equal(run.elapsed, 300);
  assert.equal(parseStatus(statusFull(4, 20)).moving, true);   // LJJ en marche
  assert.equal(parseStatus(statusFull(1, 0)).moving, false);   // fin de séance
});

test('strategy chosen from Bluetooth name', () => {
  assert.equal(core.strategyForDevice('FS-E30107'), 'fitshow');
  assert.equal(core.strategyForDevice('LJJ-0811FE'), 'ljj');
  assert.equal(core.strategyForDevice(''), 'fitshow');
});

// ---------- Séquences FitShow (RUNimon) ----------

test('fitshow: START 53 01 is sent first, speed only after RUNNING', async () => {
  const { ctl, run, sent, device, errors } = setup(FitShowTreadmill);
  await run(1600);
  ctl.setSpeed(3.0);                    // à l'arrêt : rien n'est envoyé
  assert.ok(!sent().some(isSpeed));
  ctl.start();
  await run(1000);
  assert.ok(sent().includes(START_HEX));
  assert.ok(!sent().includes('02 44 01 45 03'), 'no LJJ wake in fitshow strategy');
  assert.equal(ctl.state.phase, 'countdown');
  assert.ok(!sent().some(isSpeed), 'no speed command during countdown');
  await run(6000);
  assert.equal(device.code, 3);
  assert.equal(ctl.state.running, true);
  assert.equal(device.speed, 30);
  assert.equal(ctl.state.speed, 3.0);
  const iStart = sent().indexOf(START_HEX);
  const iSpeed = sent().findIndex(isSpeed);
  assert.ok(iSpeed > iStart);
  assert.equal(sent().filter(h => h === START_HEX).length, 1);
  assert.deepEqual(errors(), []);
});

test('fitshow: Start → Stop → Restart at minimum speed', async () => {
  const { ctl, run, sent, device, errors } = setup(FitShowTreadmill);
  await run(1600);
  ctl.setSpeed(1.0);
  ctl.start();
  await run(6000);
  assert.equal(ctl.state.running, true);
  assert.equal(device.speed, 10);

  ctl.stop();
  await run(4000);
  assert.equal(device.code, 0);
  assert.equal(ctl.state.running, false);
  assert.equal(ctl.state.phase, 'stopped');

  // Rien ne doit redémarrer tout seul
  const before = sent().length;
  await run(10000);
  assert.ok(sent().slice(before).every(h => h === '02 51 51 03'), 'only heartbeat while stopped');
  assert.equal(device.code, 0);

  ctl.start();
  await run(6000);
  assert.equal(device.code, 3);
  assert.equal(ctl.state.running, true);
  assert.equal(sent().filter(h => h === START_HEX).length, 2);
  assert.deepEqual(errors(), []);
});

test('fitshow: Stop is sent immediately, even with a pending command', async () => {
  const { ctl, run, sent, device } = setup(FitShowTreadmill);
  await run(1600);
  ctl.start();
  await run(6000);
  ctl.setSpeed(4.0);
  ctl.setSpeed(5.0);
  // pas de tick : Stop part tout de suite
  const n = sent().length;
  await ctl.stop();
  assert.equal(sent()[n], STOP_HEX);
  await run(4000);
  assert.equal(device.code, 0);
  assert.ok(!sent().slice(n).some(isSpeed), 'queued speed commands purged by Stop');
});

test('fitshow: Stop during countdown cancels start sequence (no restart)', async () => {
  const { ctl, run, sent, device } = setup(FitShowTreadmill);
  await run(1600);
  ctl.start();
  await run(1200);
  assert.equal(ctl.state.phase, 'countdown');
  await ctl.stop();
  await run(15000);
  assert.equal(device.code, 0);
  assert.equal(ctl.state.running, false);
  assert.ok(!sent().some(isSpeed));
  assert.equal(sent().filter(h => h === START_HEX).length, 1);
});

test('fitshow: Stop is re-sent (bounded) if the belt keeps running', async () => {
  const { ctl, run, sent, device } = setup(FitShowTreadmill, { deviceOpts: { ignoreStops: 1 } });
  await run(1600);
  ctl.start();
  await run(6000);
  await ctl.stop();
  await run(6000);
  assert.equal(sent().filter(h => h === STOP_HEX).length, 2);
  assert.equal(device.code, 0);

  const stubborn = setup(FitShowTreadmill, { deviceOpts: { ignoreStops: 99 } });
  await stubborn.run(1600);
  stubborn.ctl.start();
  await stubborn.run(6000);
  await stubborn.ctl.stop();
  await stubborn.run(20000);
  assert.equal(stubborn.sent().filter(h => h === STOP_HEX).length, 3, 'max 3 Stop');
});

test('fitshow: no automatic retry when the device never starts', async () => {
  const { ctl, run, sent, logs } = setup(FitShowTreadmill, { deviceOpts: { ignoreStart: true } });
  await run(1600);
  ctl.start();
  await run(30000);
  assert.equal(sent().filter(h => h === START_HEX).length, 1);
  assert.ok(!sent().some(isSpeed));
  assert.equal(ctl.startSeq, null);
  assert.equal(ctl.state.phase, 'stopped');
  assert.ok(logs.some(l => /n'a pas signalé de démarrage/.test(l.msg)));
});

test('fitshow: missing START ack produces no error and does not block', async () => {
  const { ctl, run, errors } = setup(FitShowTreadmill, { deviceOpts: { ackStart: false } });
  await run(1600);
  ctl.start();
  await run(6000);
  assert.equal(ctl.state.running, true);
  assert.deepEqual(errors(), []);
});

test('heartbeat keeps polling while running and while idle', async () => {
  const { ctl, run, sent } = setup(FitShowTreadmill);
  await run(1600);
  ctl.start();
  await run(6000);
  const n = sent().length;
  await run(5000);
  const polls = sent().slice(n).filter(h => h === '02 51 51 03').length;
  assert.ok(polls >= 8, `expected ~10 polls, got ${polls}`);
});

test('speed range read from SPEED_INFO; setpoint is clamped', async () => {
  const { ctl, run } = setup(FitShowTreadmill, { deviceOpts: { minSpeed: 8 } });
  await run(2000);
  assert.equal(ctl.state.minSpeed, 8);
  assert.equal(ctl.state.maxSpeed, 60);
  assert.equal(ctl.setSpeed(0.2), 0.8);
  assert.equal(ctl.setSpeed(9), 6);
});

test('invalid frames are ignored without changing state', async () => {
  const { ctl, run } = setup(FitShowTreadmill);
  await run(1600);
  ctl.handleNotification(Uint8Array.from([0x02, 0x51, 0x03, 0x99, 0x03]));
  assert.equal(ctl.state.running, false);
});

// ---------- Stratégie LJJ-0811FE (compatibilité) ----------

test('ljj: Wake + Speed start, confirmation, running with code 0x04, stop, restart', async () => {
  const { ctl, run, sent, device, errors } = setup(LjjTreadmill, { name: 'LJJ-0811FE' });
  assert.equal(ctl.state.strategy, 'ljj');
  await run(1600);
  ctl.setSpeed(2.0);
  assert.ok(!sent().some(isSpeed), 'no speed command while idle');
  ctl.start();
  await run(3000);
  assert.ok(!sent().includes(START_HEX));
  const iWake = sent().indexOf('02 44 01 45 03');
  const iSpeed = sent().findIndex(isSpeed);
  assert.ok(iWake >= 0 && iSpeed > iWake);
  assert.equal(sent().filter(isSpeed).length, 2, 'speed + 1.5 s confirmation');
  assert.equal(device.speed, 20);
  assert.equal(ctl.state.running, true);
  assert.equal(ctl.state.phase, 'running');

  await ctl.stop();
  await run(2000);
  assert.equal(device.speed, 0);
  assert.equal(ctl.state.running, false);
  assert.equal(sent().filter(h => h === STOP_HEX).length, 1);

  ctl.start();
  await run(3000);
  assert.equal(ctl.state.running, true);
  assert.deepEqual(errors(), []);
});

test('ljj: Stop before the 1.5 s confirmation prevents a restart', async () => {
  const { ctl, run, device } = setup(LjjTreadmill, { name: 'LJJ-0811FE' });
  await run(1600);
  ctl.start();
  await run(1100);
  await ctl.stop();
  await run(5000);
  assert.equal(device.speed, 0);
  assert.equal(ctl.state.running, false);
});

test('strategy can be forced manually', () => {
  const { ctl } = setup(FitShowTreadmill, { name: 'FS-E30107', strategy: 'ljj' });
  assert.equal(ctl.state.strategy, 'ljj');
});

test('unanswered INFO queries never starve the heartbeat', async () => {
  const { ctl, run, sent } = setup(LjjTreadmill, { name: 'LJJ-0811FE' }); // ne répond pas à 50 03
  await run(8000);
  const first = sent().slice(0, 8);
  const polls = first.filter(h => h === '02 51 51 03').length;
  assert.ok(polls >= 3, `heartbeat interleaved with info retries: ${first.join(' | ')}`);
  assert.equal(sent().filter(h => h === '02 50 03 53 03').length, 3, 'INFO retried 3 times max');
  assert.equal(ctl.queue.length, 0);
});

test('status code 0x04 with a moving belt is "running" unless a Stop was just sent', async () => {
  const { ctl, run } = setup(FitShowTreadmill);
  await run(1600);
  ctl.handleNotification(Uint8Array.from(statusFull(4, 20)));
  assert.equal(ctl.state.phase, 'running');
  ctl.setSpeed(3.0);
  assert.ok(ctl.queue.some(e => e.bytes[2] === 0x02), 'speed change accepted');
  await ctl.stop();
  ctl.handleNotification(Uint8Array.from(statusFull(4, 15)));
  assert.equal(ctl.state.phase, 'stopping');
  assert.equal(ctl.start(), false, 'no restart while decelerating');
});
