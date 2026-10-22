// Horloge simulée + tapis Bluetooth simulés (FitShow standard et LJJ-0811FE)
'use strict';
const { buildFrame, checksum, hex, OP, CTRL } = require('../treadmill-core.js');

class FakeClock {
  constructor() { this.t = 0; this.timers = []; this.seq = 0; }
  now() { return this.t; }
  setTimeout(fn, ms) { const id = ++this.seq; this.timers.push({ id, at: this.t + ms, fn }); return id; }
  clearTimeout(id) { this.timers = this.timers.filter(t => t.id !== id); }
  // Exécute les timers échus dans l'ordre chronologique
  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      await next.fn();
      await flush();
    }
    this.t = end;
  }
}

const flush = () => new Promise(r => setImmediate(r));

// Trame de réponse avec checksum
const frame = (...bytes) => [...buildFrame(bytes)];

function statusFull(code, speedTenths, elapsed = 0) {
  const b = [0x02, 0x51, code, speedTenths, 0, elapsed & 0xff, elapsed >> 8, 0, 0, 0, 0, 0, 0, 0, 0];
  return frame(...b);
}

// Tapis FitShow standard (comportement attendu du RUNimon FS-E30107) :
//  - 53 02 à l'arrêt : ignoré, répond avec vitesse réelle 0
//  - 53 01 : compte à rebours 3 s, puis RUNNING à la vitesse mini
//  - 53 03 : décélération (code 4) 1 s, puis END (1), puis NORMAL (0)
class FitShowTreadmill {
  constructor(clock, opts = {}) {
    this.clock = clock;
    this.code = 0; this.speed = 0; this.target = 0;
    this.minSpeed = opts.minSpeed || 10;
    this.ignoreStops = opts.ignoreStops || 0; // nombre de Stop ignorés
    this.ackStart = opts.ackStart !== false;
    this.ignoreStart = !!opts.ignoreStart;
    this.received = [];
    this.notify = null;
  }
  reply(bytes) { this.clock.setTimeout(() => this.notify(Uint8Array.from(bytes)), 40); }
  write(f) {
    const b = [...f];
    this.received.push(hex(b));
    if (b[1] === OP.STATUS) {
      if (this.code === 3 || this.code === 4) this.reply(statusFull(this.code, this.speed));
      else if (this.code === 2) this.reply(frame(0x02, 0x51, 0x02, this.countdown));
      else this.reply(frame(0x02, 0x51, this.code));
    } else if (b[1] === OP.INFO && b[2] === 0x02) {
      this.reply(frame(0x02, 0x50, 0x02, 60, this.minSpeed, 0));
    } else if (b[1] === OP.INFO && b[2] === 0x03) {
      this.reply(frame(0x02, 0x50, 0x03, 0, 0, 0));
    } else if (b[1] === OP.CONTROL && b[2] === CTRL.START) {
      if (this.ignoreStart) return;
      if (this.ackStart) this.reply(frame(0x02, 0x53, 0x01));
      if (this.code === 0 || this.code === 1 || this.code === 10) {
        this.code = 2; this.countdown = 3;
        const tickDown = () => {
          if (this.code !== 2) return;
          this.countdown--;
          if (this.countdown <= 0) { this.code = 3; this.speed = this.target || this.minSpeed; }
          else this.clock.setTimeout(tickDown, 1000);
        };
        this.clock.setTimeout(tickDown, 1000);
      }
    } else if (b[1] === OP.CONTROL && b[2] === CTRL.TARGET) {
      if (this.code === 3) { this.speed = b[3]; }
      this.reply(frame(0x02, 0x53, 0x02, this.code === 3 ? this.speed : 0, 0));
    } else if (b[1] === OP.CONTROL && b[2] === CTRL.STOP) {
      this.reply(frame(0x02, 0x53, 0x03));
      if (this.ignoreStops > 0) { this.ignoreStops--; return; }
      if (this.code === 2) { this.code = 0; return; }
      if (this.code === 3) {
        this.code = 4;
        this.clock.setTimeout(() => { this.speed = 0; this.code = 1; }, 1000);
        this.clock.setTimeout(() => { if (this.code === 1) this.code = 0; }, 2000);
      }
    }
    // 0x44 (Wake LJJ) : inconnu du protocole FitShow, pas de réponse
  }
}

// Tapis LJJ-0811FE : 53 01 ignoré, Wake requis, 53 02 démarre la bande,
// trame d'état complète avec code 0x04 pendant la marche.
class LjjTreadmill {
  constructor(clock) {
    this.clock = clock; this.awake = false; this.speed = 0; this.received = []; this.notify = null;
  }
  reply(bytes) { this.clock.setTimeout(() => this.notify(Uint8Array.from(bytes)), 40); }
  write(f) {
    const b = [...f];
    this.received.push(hex(b));
    if (b[1] === OP.STATUS) {
      if (this.speed > 0) this.reply(statusFull(0x04, this.speed));
      else this.reply(frame(0x02, 0x51, 0x00));
    } else if (b[1] === OP.WAKE) {
      this.awake = true;
    } else if (b[1] === OP.INFO && b[2] === 0x02) {
      this.reply(frame(0x02, 0x50, 0x02, 60, 10, 0));
    } else if (b[1] === OP.CONTROL && b[2] === CTRL.TARGET) {
      if (this.awake) this.speed = b[3];
      this.reply(frame(0x02, 0x53, 0x02, this.speed, 0));
    } else if (b[1] === OP.CONTROL && b[2] === CTRL.STOP) {
      this.speed = 0; this.awake = false;
      this.reply(frame(0x02, 0x53, 0x03));
    }
  }
}

module.exports = { FakeClock, FitShowTreadmill, LjjTreadmill, frame, statusFull, flush, checksum };
