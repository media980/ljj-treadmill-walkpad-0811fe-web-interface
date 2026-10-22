// =======================================================
//  Cœur protocole FitShow (sans DOM, sans Web Bluetooth)
//  Chargé par index.html (window.TreadmillCore) et par les tests Node
//  (require('./treadmill-core.js')).
//
//  Trame : [0x02, opcode, ...params, checksum, 0x03]
//  checksum = XOR des octets entre 0x02 et le checksum (exclus).
//
//  Références protocole :
//   - FitShow / FitMonster "FM-Protocol-Treadmill"
//   - implémentation open-source qdomyos-zwift (fitshowtreadmill.h/.cpp),
//     utilisée avec de nombreux tapis "FS-xxxx"
// =======================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TreadmillCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FRAME_START = 0x02;
  const FRAME_END = 0x03;

  const OP = {
    INFO:    0x50, // SYS_INFO
    STATUS:  0x51, // SYS_STATUS (heartbeat)
    DATA:    0x52, // SYS_DATA
    CONTROL: 0x53, // SYS_CONTROL
    WAKE:    0x44, // spécifique LJJ-0811FE (hors protocole FitShow standard)
  };

  // Sous-commandes SYS_CONTROL (0x53)
  const CTRL = {
    USER:   0x00,
    START:  0x01, // READY_OR_START : démarre / reprend
    TARGET: 0x02, // TARGET_OR_RUN : vitesse + inclinaison cibles
    STOP:   0x03,
    PAUSE:  0x06,
  };

  // Codes d'état SYS_STATUS (octet [2] de la réponse 0x51)
  const STATUS = {
    NORMAL:  0,  // au repos
    END:     1,  // séance terminée
    START:   2,  // compte à rebours de démarrage (octet [3] = secondes)
    RUNNING: 3,  // en marche
    STOP:    4,  // décélération / arrêt en cours (LJJ-0811FE : envoyé aussi en marche)
    ERROR:   5,
    SAFETY:  6,  // clé de sécurité retirée
    STUDY:   7,
    PAUSED:  10,
  };

  // Commandes (sans checksum ni 0x03 final, ajoutés par buildFrame)
  const CMD = {
    STATUS:       [0x02, OP.STATUS],
    WAKE:         [0x02, OP.WAKE, 0x01],
    STOP:         [0x02, OP.CONTROL, CTRL.STOP],
    SPEED_INFO:   [0x02, OP.INFO, 0x02],
    INCLINE_INFO: [0x02, OP.INFO, 0x03],
    // START/RESUME : 53 01 + sport ID (4 octets LE) + mode (0 = normal)
    //                + nombre de blocs (1 octet) + valeur du mode (2 octets)
    START:        [0x02, OP.CONTROL, CTRL.START, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  };

  function setSpeedCmd(speedTenths, incline) {
    return [0x02, OP.CONTROL, CTRL.TARGET, speedTenths & 0xff, (incline || 0) & 0xff];
  }

  // XOR de tous les octets à partir de l'index 1 (on saute le 0x02)
  function checksum(bytes) {
    let cs = 0;
    for (let i = 1; i < bytes.length; i++) cs ^= bytes[i];
    return cs;
  }

  function buildFrame(bytes) {
    const frame = new Uint8Array(bytes.length + 2);
    frame.set(bytes, 0);
    frame[bytes.length] = checksum(bytes);
    frame[bytes.length + 1] = FRAME_END;
    return frame;
  }

  // Vérifie l'encadrement et le checksum d'une trame reçue
  function isValidFrame(bytes) {
    if (!bytes || bytes.length < 4) return false;
    if (bytes[0] !== FRAME_START || bytes[bytes.length - 1] !== FRAME_END) return false;
    return checksum(bytes.slice(0, bytes.length - 2)) === bytes[bytes.length - 2];
  }

  const hex = arr => [...arr].map(b => b.toString(16).padStart(2, '0')).join(' ');

  // Une réponse correspond à une commande envoyée si l'opcode concorde et,
  // pour INFO/CONTROL, la sous-commande aussi. Les paramètres ne sont PAS
  // comparés : la réponse à SET_SPEED rapporte la vitesse RÉELLE.
  function responseMatches(sent, rx) {
    if (!sent || !rx || rx.length < 3 || rx[1] !== sent[1]) return false;
    if ((sent[1] === OP.CONTROL || sent[1] === OP.INFO) && sent.length > 2) {
      return rx[2] === sent[2];
    }
    return true;
  }

  // Décode une réponse STATUS (0x51)
  //  court  : 02 51 <code> cs 03                      (repos, fin…)
  //  décompte : 02 51 02 <secondes> cs 03
  //  complet (17 octets) :
  //   [2] code  [3] vitesse×10  [4] inclinaison
  //   [5..6] temps (s, LE)  [7..8] distance (LE, /1000 → km)
  //   [9..10] calories×10 (LE)  [11..14] réservés  [15] cs  [16] 0x03
  function parseStatus(bytes) {
    const st = { code: bytes[2], full: false, speed: 0, incline: 0, countdown: null };
    if (st.code === STATUS.START && bytes.length >= 6) st.countdown = bytes[3];
    if (bytes.length >= 17) {
      st.full = true;
      st.speed = bytes[3] / 10;
      st.incline = bytes[4];
      st.elapsed = bytes[5] + (bytes[6] << 8);
      st.distanceRaw = bytes[7] + (bytes[8] << 8);
      st.distance = st.distanceRaw / 1000;
      st.caloriesRaw = bytes[9] + (bytes[10] << 8);
      st.calories = st.caloriesRaw / 10;
    }
    // La bande tourne : code RUNNING, ou trame complète avec vitesse > 0
    // (le LJJ-0811FE envoie le code 0x04 pendant la marche).
    st.moving = st.code === STATUS.RUNNING || (st.full && st.speed > 0);
    return st;
  }

  // Stratégie de démarrage selon le nom Bluetooth
  //  'fitshow' : 53 01 (Start/Resume) → attente RUNNING → 53 02 (vitesse)
  //  'ljj'     : 44 01 (Wake) → 53 02 (vitesse) → confirmation 1,5 s
  function strategyForDevice(name) {
    return /^LJJ/i.test(name || '') ? 'ljj' : 'fitshow';
  }

  const DEFAULTS = {
    pendingTimeoutMs: 1000,  // délai d'attente d'une réponse
    infoRetries: 3,          // seules les requêtes INFO sont retransmises
    startTimeoutMs: 10000,   // délai max entre Start et l'état RUNNING
    speedConfirmMs: 1500,    // délai avant (re)confirmation de vitesse
    stopVerifyMs: 2000,      // vérification de l'arrêt effectif
    stopMaxAttempts: 3,      // envois de Stop au maximum
    stoppingWindowMs: 15000, // fenêtre où le code 0x04 signifie « arrêt en cours »
  };

  class TreadmillController {
    constructor(opts) {
      this.write = opts.write;           // async (Uint8Array) => void
      this.log = opts.log || (() => {});
      this.onUpdate = opts.onUpdate || (() => {});
      this.now = opts.now || (() => Date.now());
      this.setTimeout = opts.setTimeout || ((f, ms) => setTimeout(f, ms));
      this.clearTimeout = opts.clearTimeout || (h => clearTimeout(h));
      this.cfg = Object.assign({}, DEFAULTS, opts.config || {});
      this.state = {
        connected: false,
        strategy: 'fitshow',
        running: false,
        statusCode: null,
        lastStatus: null,
        speed: 0,
        incline: 0,
        setpoint: 1.0,
        minSpeed: 10,     // en 0,1 km/h
        maxSpeed: 80,
        unitSpeed: 10,
        elapsed: 0,
        distance: 0,
        calories: undefined,
        countdown: null,
        phase: 'disconnected',
        startRequestedAt: null,
        lastUserSpeedChangeAt: null,
      };
      this.queue = [];
      this.pending = null;
      this.inFlight = 0;
      this.chain = Promise.resolve();
      this.startSeq = null;
      this.stopSeq = null;
      this.lastStopAt = null;
      this.seqId = 0;
    }

    // ---------- Cycle de vie ----------
    attach(deviceName, strategy) {
      this.reset();
      this.state.connected = true;
      this.state.strategy = strategy && strategy !== 'auto' ? strategy : strategyForDevice(deviceName);
      this.state.phase = 'unknown';
      this.log(`Stratégie de démarrage : ${this.state.strategy === 'ljj' ? 'LJJ (Wake + vitesse)' : 'FitShow (Start 53 01 puis vitesse)'}`, 'info');
      this.enqueue(CMD.SPEED_INFO, 'info');
      this.enqueue(CMD.INCLINE_INFO, 'info');
    }

    setStrategy(strategy, deviceName) {
      this.state.strategy = strategy && strategy !== 'auto' ? strategy : strategyForDevice(deviceName);
    }

    reset() {
      this._cancelStart();
      this._cancelStopVerify();
      this.queue = [];
      this.pending = null;
      Object.assign(this.state, {
        connected: false, running: false, statusCode: null, lastStatus: null,
        speed: 0, incline: 0, countdown: null, phase: 'disconnected',
      });
    }

    // ---------- File d'envoi ----------
    enqueue(bytes, kind, label) {
      this.queue.push({ bytes, kind, label, attempts: 0 });
    }

    _writeEntry(entry) {
      entry.attempts++;
      this.pending = { entry, sentAt: this.now() };
      const frame = buildFrame(entry.bytes);
      this.log(`TX : ${hex(frame)}`, 'tx');
      this.inFlight++;
      // Les opérations GATT doivent être sérialisées
      const p = this.chain.then(() => this.write(frame));
      this.chain = p.catch(() => {}).then(() => { this.inFlight--; });
      return p.catch(e => this.log('Erreur write : ' + e.message, 'err'));
    }

    // Appelé toutes les 500 ms : envoie la commande suivante ou un heartbeat
    async tick() {
      if (!this.state.connected || this.inFlight > 0) return;
      if (this.pending) {
        if (this.now() - this.pending.sentAt < this.cfg.pendingTimeoutMs) return;
        const { entry } = this.pending;
        this.pending = null;
        if (entry.kind === 'info' && entry.attempts < this.cfg.infoRetries) {
          this.queue.push(entry); // nouvel essai plus tard, sans bloquer le reste
        } else if (entry.kind === 'info') {
          this.log(`Pas de réponse à ${hex(entry.bytes)} (info ignorée)`, 'info');
        }
        // Actions : jamais retransmises. L'état réel est lu via le polling,
        // l'absence d'accusé n'est donc pas une erreur.
        // Heartbeat : on enchaîne simplement avec le suivant.
      }
      // Priorité : actions (dans l'ordre), puis requêtes INFO intercalées
      // avec le heartbeat pour ne jamais l'interrompre.
      const iAction = this.queue.findIndex(e => e.kind !== 'info');
      let entry = null;
      if (iAction >= 0) entry = this.queue.splice(iAction, 1)[0];
      else if (this.queue.length && this.lastSentKind === 'status') entry = this.queue.shift();
      if (!entry) entry = { bytes: CMD.STATUS, kind: 'status', attempts: 0 };
      this.lastSentKind = entry.kind;
      return this._writeEntry(entry);
    }

    // ---------- Réception ----------
    handleNotification(bytes) {
      if (!isValidFrame(bytes)) {
        this.log(`Trame invalide ignorée : ${hex(bytes)}`, 'err');
        return;
      }
      if (this.pending && responseMatches(this.pending.entry.bytes, bytes)) {
        this.pending = null;
      }
      const op = bytes[1];
      if (op === OP.STATUS) this._onStatus(parseStatus(bytes), bytes);
      else if (op === OP.INFO) this._onInfo(bytes);
      else if (op === OP.CONTROL) this._onControl(bytes);
    }

    _onInfo(bytes) {
      if (bytes[2] === 0x02 && bytes.length >= 7) {
        const max = bytes[3], min = bytes[4];
        if (min > 0 && max > min) {
          this.state.maxSpeed = max;
          this.state.minSpeed = min;
          this.state.unitSpeed = bytes[5] || 10;
          if (this.state.setpoint < min / 10) this.state.setpoint = min / 10;
          this.log(`Vitesse : min=${min} max=${max} unit=${this.state.unitSpeed}`, 'info');
          this.onUpdate('range');
        }
      }
    }

    _onControl(bytes) {
      const sub = bytes[2];
      if (sub === CTRL.TARGET && bytes.length >= 6) {
        // Le tapis renvoie sa vitesse RÉELLE (pas la consigne)
        const actual = bytes[3] / 10;
        if (!this.state.running && actual === 0) {
          this.log('Vitesse réelle 0 : le tapis n\'est pas en marche (consigne mémorisée)', 'info');
        }
      } else if (sub === CTRL.START) {
        this.log('Start accepté par le tapis', 'rx');
      } else if (sub === CTRL.STOP) {
        this.log('Stop accepté par le tapis', 'rx');
      }
    }

    _onStatus(st, bytes) {
      const s = this.state;
      const prevCode = s.statusCode;
      const wasRunning = s.running;
      s.statusCode = st.code;
      s.lastStatus = st;
      s.lastStatusBytes = bytes;
      s.running = st.moving;
      s.countdown = st.countdown;
      if (st.full) {
        s.speed = st.speed;
        s.incline = st.incline;
        s.elapsed = st.elapsed;
        s.distance = st.distance;
        s.calories = st.calories;
      } else if (!st.moving) {
        s.speed = 0;
      }
      s.phase = this._phaseFor(st);

      if (st.code !== prevCode || st.moving !== wasRunning) {
        if (st.code === STATUS.START) this.log(`Compte à rebours de démarrage${st.countdown != null ? ` : ${st.countdown}` : ''}`, 'info');
        else if (st.moving && !wasRunning) this.log('Tapis en marche', 'rx');
        else if (!st.moving && wasRunning) this.log('Tapis arrêté', 'info');
        else if (st.code === STATUS.SAFETY) this.log('⚠️ Clé de sécurité retirée', 'err');
        else if (st.code === STATUS.ERROR) this.log(`⚠️ Erreur tapis (code ${bytes[3]})`, 'err');
      }

      // Séquence de démarrage FitShow : on attend RUNNING avant la vitesse
      const seq = this.startSeq;
      if (seq && seq.strategy === 'fitshow' && st.moving && !seq.speedSent) {
        seq.speedSent = true;
        this._sendTargetIfNeeded(seq);
      }
      if (this.stopSeq && !st.moving && st.code !== STATUS.START) this._cancelStopVerify();
      this.onUpdate('status');
    }

    _phaseFor(st) {
      if (st.code === STATUS.START) return 'countdown';
      if (st.code === STATUS.PAUSED) return 'paused';
      if (st.code === STATUS.SAFETY) return 'safety';
      if (st.code === STATUS.ERROR) return 'error';
      if (st.moving) {
        // Code 0x04 = décélération seulement juste après un Stop : certains
        // modèles (LJJ-0811FE) l'envoient aussi en marche normale.
        const sinceStop = this.now() - (this.lastStopAt ?? -Infinity);
        if (st.code === STATUS.STOP && sinceStop < this.cfg.stoppingWindowMs) return 'stopping';
        return 'running';
      }
      if (this.startSeq) return 'starting';
      return 'stopped';
    }

    // ---------- Commandes utilisateur ----------
    start() {
      const s = this.state;
      if (!s.connected) return false;
      if (s.phase === 'stopping') {
        this.log('Arrêt en cours : attendez l\'arrêt complet avant de redémarrer', 'err');
        return false;
      }
      if (s.phase === 'safety') {
        this.log('Clé de sécurité retirée : démarrage impossible', 'err');
        return false;
      }
      if (this.startSeq || s.phase === 'countdown') {
        this.log('Démarrage déjà en cours', 'info');
        return false;
      }
      if (s.running) {
        // Déjà en marche : Start applique simplement la consigne
        this.setSpeed(s.setpoint);
        return true;
      }
      this._cancelStart();
      this._cancelStopVerify();
      const target = Math.round(s.setpoint * 10);
      const seq = { id: ++this.seqId, strategy: s.strategy, target, speedSent: false, confirmed: false, timers: [] };
      this.startSeq = seq;
      s.startRequestedAt = this.now();
      s.lastUserSpeedChangeAt = this.now();
      s.phase = 'starting';

      if (seq.strategy === 'ljj') {
        this.log('Démarrage LJJ (Wake + Speed)...', 'tx');
        this.enqueue(CMD.WAKE, 'action');
        this.enqueue(setSpeedCmd(target, 0), 'action');
        seq.speedSent = true;
        seq.timers.push(this.setTimeout(() => {
          if (this.startSeq !== seq) return;
          this.log(`Confirmation vitesse à ${(seq.target / 10).toFixed(1)} km/h`, 'tx');
          this._queueSpeed(seq.target);
          this._finishStart(seq);
        }, this.cfg.speedConfirmMs));
      } else {
        this.log('Démarrage FitShow (Start 53 01)...', 'tx');
        this.enqueue(CMD.START, 'action');
        seq.timers.push(this.setTimeout(() => {
          if (this.startSeq !== seq || seq.speedSent) return;
          this.log('Le tapis n\'a pas signalé de démarrage. Aucun nouvel essai automatique — vérifiez la clé de sécurité / l\'écran puis réessayez.', 'err');
          this._finishStart(seq);
          this.onUpdate('status');
        }, this.cfg.startTimeoutMs));
      }
      this.onUpdate('status');
      return true;
    }

    _sendTargetIfNeeded(seq) {
      const actual = Math.round(this.state.speed * 10);
      if (actual !== seq.target) {
        this.log(`Consigne de vitesse : ${(seq.target / 10).toFixed(1)} km/h`, 'tx');
        this._queueSpeed(seq.target);
      }
      // Une seule reconfirmation si la vitesse réelle n'a pas suivi
      seq.timers.push(this.setTimeout(() => {
        if (this.startSeq !== seq) return;
        if (this.state.running && Math.round(this.state.speed * 10) !== seq.target) {
          this._queueSpeed(seq.target);
        }
        this._finishStart(seq);
      }, this.cfg.speedConfirmMs * 2));
    }

    _finishStart(seq) {
      if (this.startSeq !== seq) return;
      seq.timers.forEach(t => this.clearTimeout(t));
      this.startSeq = null;
    }

    _cancelStart() {
      if (this.startSeq) this._finishStart(this.startSeq);
    }

    // Remplace une consigne de vitesse encore en file (pas d'accumulation)
    _queueSpeed(target) {
      this.queue = this.queue.filter(e => !(e.bytes[1] === OP.CONTROL && e.bytes[2] === CTRL.TARGET));
      this.enqueue(setSpeedCmd(target, this.state.incline || 0), 'action');
    }

    setSpeed(kmh) {
      const s = this.state;
      kmh = Math.max(s.minSpeed / 10, Math.min(s.maxSpeed / 10, kmh));
      kmh = Math.round(kmh * 10) / 10;
      s.setpoint = kmh;
      s.lastUserSpeedChangeAt = this.now();
      if (!s.connected) return kmh;
      if (this.startSeq) {
        // Démarrage en cours : la nouvelle consigne sera appliquée à RUNNING
        this.startSeq.target = Math.round(kmh * 10);
        if (this.startSeq.speedSent) this._queueSpeed(this.startSeq.target);
      } else if (s.running && s.phase !== 'stopping') {
        this._queueSpeed(Math.round(kmh * 10));
      }
      // À l'arrêt : aucune commande (évite tout démarrage involontaire)
      return kmh;
    }

    wake() {
      if (!this.state.connected) return;
      this.log('Réveil du tapis...', 'tx');
      this.enqueue(CMD.WAKE, 'action');
    }

    // Stop prioritaire : annule le démarrage, purge les actions et envoie
    // immédiatement, sans attendre le heartbeat.
    stop() {
      if (!this.state.connected) return Promise.resolve();
      this.log('Envoi Stop...', 'tx');
      this.lastStopAt = this.now();
      this._cancelStart();
      this._cancelStopVerify();
      this.queue = this.queue.filter(e => e.kind === 'info');
      const seq = { attempts: 0, timer: null };
      this.stopSeq = seq;
      const send = () => {
        seq.attempts++;
        const p = this._writeEntry({ bytes: CMD.STOP, kind: 'stop', attempts: 0 });
        seq.timer = this.setTimeout(() => {
          if (this.stopSeq !== seq) return;
          const code = this.state.statusCode;
          const stillGoing = code === STATUS.RUNNING || code === STATUS.START;
          if (stillGoing && seq.attempts < this.cfg.stopMaxAttempts) {
            this.log('Le tapis tourne encore : nouvel envoi de Stop', 'err');
            send();
          } else {
            this._cancelStopVerify();
          }
        }, this.cfg.stopVerifyMs);
        return p;
      };
      return send();
    }

    _cancelStopVerify() {
      if (this.stopSeq) {
        if (this.stopSeq.timer) this.clearTimeout(this.stopSeq.timer);
        this.stopSeq = null;
      }
    }
  }

  return {
    OP, CTRL, STATUS, CMD, FRAME_START, FRAME_END,
    checksum, buildFrame, isValidFrame, responseMatches, parseStatus,
    setSpeedCmd, strategyForDevice, hex, TreadmillController,
  };
});
