/**
 * Strame thin web client — Standard Online (browser vs browser).
 * Embed: StrameWeb.mount("#container", { relayUrl: "wss://…/ws" });
 */
(function (global) {
  "use strict";

  const STARTING_GOLD = 5;
  const RECRUIT_COST = 1;
  const KILL_GOLD = 1;

  const UNITS = {
    S: { tag: "S", name: "Soldier", ordinal: 0, maxHp: 3, atk: 1, move: 1, diagonalAtk: true },
    G: { tag: "G", name: "Gollem", ordinal: 1, maxHp: 5, atk: 2, move: 1, diagonalAtk: false },
  };

  const MAPS = {
    STANDARD_5X10: { rows: 5, cols: 10, river: false, label: "Standard 5×10" },
    RIVER_5X10: { rows: 5, cols: 10, river: true, label: "5×10 River" },
  };

  function defaultRelayUrl() {
    const fromQuery = new URLSearchParams(location.search).get("relay");
    if (fromQuery) return fromQuery;
    if (location.protocol === "http:" && (location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
      return "ws://127.0.0.1:8080/ws";
    }
    return "";
  }

  const DEFAULT_RELAY = defaultRelayUrl();
  const RELAY_PLACEHOLDER = "wss://your-relay.onrender.com/ws";

  function rc(r, c) {
    return r + 1 + "," + (c + 1);
  }

  function parseRc(s) {
    const m = /^(\d+),(\d+)$/.exec(s);
    if (!m) return null;
    return { r: +m[1] - 1, c: +m[2] - 1 };
  }

  function shortP(p) {
    return p === 0 ? "P1" : "P2";
  }

  function fnvMix(h, v) {
    let x = v >>> 0;
    h = BigInt.asUintN(64, BigInt(h) ^ BigInt(x));
    h = BigInt.asUintN(64, BigInt(h) * 0x100000001b3n);
    return Number(h);
  }

  class GameModel {
    constructor() {
      this.resetBoard(5, 10, false);
      this.resetSession();
    }

    resetSession() {
      this.gold = [STARTING_GOLD, STARTING_GOLD];
      this.turnNumber = 0;
      this.current = 0;
      this.mayPlaceThisTurn = true;
      this.moved = new Set();
      this.attacked = new Set();
      this.passed = new Set();
      this.placed = new Set();
      this.nextId = 1;
      this.startingGoldOverride = 0;
      this.outcome = "ongoing";
      this.selected = null;
      this.uiMode = "idle";
      this.recruitUnit = "S";
      this.applyingRemote = false;
      this.actionHook = null;
    }

    resetBoard(rows, cols, river) {
      this.rows = rows;
      this.cols = cols;
      this.water = Array.from({ length: rows }, () => Array(cols).fill(false));
      if (river) {
        for (let r = 0; r < rows; r++) {
          const mid = Math.floor(cols / 2);
          this.water[r][mid] = true;
          if (mid + 1 < cols) this.water[r][mid + 1] = true;
        }
      }
      this.grid = Array.from({ length: rows }, () => Array(cols).fill(null));
    }

    configureMap(mapId) {
      const m = MAPS[mapId] || MAPS.STANDARD_5X10;
      this.resetBoard(m.rows, m.cols, m.river);
      this.resetSession();
    }

    homeCol(p) {
      return p === 0 ? 0 : this.cols - 1;
    }

    pieceAt(r, c) {
      if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) return null;
      return this.grid[r][c];
    }

    isEmpty(r, c) {
      return this.pieceAt(r, c) === null;
    }

    countPieces(p) {
      let n = 0;
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const pc = this.grid[r][c];
          if (pc && pc.owner === p) n++;
        }
      }
      return n;
    }

    totalHp(p) {
      let n = 0;
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const pc = this.grid[r][c];
          if (pc && pc.owner === p) n += pc.hp;
        }
      }
      return n;
    }

    hasAttacked(id) {
      return this.attacked.has(id);
    }

    pieceNeedsAction(pc) {
      if (!pc || pc.owner !== this.current) return false;
      if (this.passed.has(pc.id)) return false;
      if (this.placed.has(pc.id)) return false;
      return !(this.moved.has(pc.id) && this.hasAttacked(pc.id));
    }

    activationsPending() {
      let n = 0;
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const pc = this.grid[r][c];
          if (pc && this.pieceNeedsAction(pc)) n++;
        }
      }
      return n;
    }

    canPlacePiece() {
      return this.mayPlaceThisTurn && this.gold[this.current] >= RECRUIT_COST;
    }

    canRecruitAt(r, c) {
      if (!this.canPlacePiece()) return false;
      if (!this.isEmpty(r, c) || this.water[r][c]) return false;
      return c === this.homeCol(this.current);
    }

    canStillRecruit() {
      if (!this.canPlacePiece()) return false;
      for (let r = 0; r < this.rows; r++) {
        if (this.canRecruitAt(r, this.homeCol(this.current))) return true;
      }
      return false;
    }

    clearSelection() {
      this.selected = null;
      this.uiMode = "idle";
    }

    select(r, c) {
      const pc = this.pieceAt(r, c);
      if (!pc || pc.owner !== this.current || !this.pieceNeedsAction(pc)) {
        this.clearSelection();
        return;
      }
      this.selected = { r, c };
      this.uiMode = "idle";
    }

    emit(line) {
      if (this.applyingRemote || !this.actionHook) return;
      if (!parseActionLine(line)) return;
      this.actionHook(line);
    }

    tryAutoEndTurn() {
      if (this.outcome !== "ongoing") return;
      if (this.applyingRemote) return;
      if (this.activationsPending() > 0) return;
      if (this.canStillRecruit()) return;
      this.finishTurn();
    }

    finishTurn() {
      if (this.outcome !== "ongoing") return;
      const endLine = shortP(this.current) + ":end";
      this.emit(endLine);
      this.moved.clear();
      this.attacked.clear();
      this.passed.clear();
      this.placed.clear();
      this.mayPlaceThisTurn = true;
      this.clearSelection();
      this.current = this.current === 0 ? 1 : 0;
      this.turnNumber++;
      this.checkGameOver();
      if (!this.applyingRemote && this.onTurnEnded) this.onTurnEnded();
    }

    endTurnEarly() {
      if (this.countPieces(this.current) === 0) return;
      this.finishTurn();
    }

    checkGameOver() {
      if (this.outcome !== "ongoing") return;
      const lost1 = this.gold[0] === 0 && this.totalHp(0) === 0;
      const lost2 = this.gold[1] === 0 && this.totalHp(1) === 0;
      if (lost1 && lost2) this.outcome = "draw";
      else if (lost1) this.outcome = "p2";
      else if (lost2) this.outcome = "p1";
    }

    createPiece(owner, unitKey, id) {
      const u = UNITS[unitKey];
      return { id, owner, unit: unitKey, hp: u.maxHp, tier: 0 };
    }

    recruit(unitKey, r, c) {
      if (!this.canRecruitAt(r, c)) return;
      const id = this.nextId++;
      const pc = this.createPiece(this.current, unitKey, id);
      this.gold[this.current] -= RECRUIT_COST;
      this.grid[r][c] = pc;
      this.placed.add(id);
      this.mayPlaceThisTurn = false;
      this.clearSelection();
      this.emit(shortP(this.current) + "·" + pc.unit + "#" + id + ":new @" + rc(r, c));
      this.afterLocalAction();
    }

    legalMoveTargets(fromR, fromC) {
      const pc = this.pieceAt(fromR, fromC);
      if (!pc || this.moved.has(pc.id)) return [];
      const out = [];
      const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      for (const [dr, dc] of dirs) {
        const r = fromR + dr, c = fromC + dc;
        if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) continue;
        if (!this.isEmpty(r, c) || this.water[r][c]) continue;
        out.push({ r, c });
      }
      return out;
    }

    legalAttackTargets(fromR, fromC) {
      const pc = this.pieceAt(fromR, fromC);
      if (!pc || this.hasAttacked(pc.id)) return [];
      const u = UNITS[pc.unit];
      const out = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const r = fromR + dr, c = fromC + dc;
          if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) continue;
          const orth = Math.abs(dr) + Math.abs(dc) === 1;
          const diag = Math.abs(dr) === 1 && Math.abs(dc) === 1;
          if (!u.diagonalAtk && diag) continue;
          if (!u.diagonalAtk && !orth) continue;
          const tgt = this.pieceAt(r, c);
          if (tgt && tgt.owner !== pc.owner) out.push({ r, c, target: tgt });
        }
      }
      return out;
    }

    moveTo(fromR, fromC, toR, toC) {
      const pc = this.pieceAt(fromR, fromC);
      if (!pc) return;
      const ok = this.legalMoveTargets(fromR, fromC).some((t) => t.r === toR && t.c === toC);
      if (!ok) return;
      this.grid[fromR][fromC] = null;
      this.grid[toR][toC] = pc;
      this.moved.add(pc.id);
      this.selected = { r: toR, c: toC };
      this.uiMode = "idle";
      this.emit(
        shortP(pc.owner) + "·" + pc.unit + "#" + pc.id + ":mv " + rc(fromR, fromC) + "→" + rc(toR, toC)
      );
      this.afterLocalAction();
    }

    attack(fromR, fromC, toR, toC) {
      const atk = this.pieceAt(fromR, fromC);
      const tgt = this.pieceAt(toR, toC);
      if (!atk || !tgt || tgt.owner === atk.owner) return;
      const ok = this.legalAttackTargets(fromR, fromC).some((t) => t.r === toR && t.c === toC);
      if (!ok) return;
      const u = UNITS[atk.unit];
      const dmg = u.atk;
      tgt.hp -= dmg;
      let killed = tgt.hp <= 0;
      const hpLeft = Math.max(0, tgt.hp);
      if (killed) {
        this.grid[toR][toC] = null;
        this.gold[atk.owner] += KILL_GOLD;
        this.moved.delete(atk.id);
        this.attacked.delete(atk.id);
      } else {
        this.attacked.add(atk.id);
      }
      this.selected = { r: fromR, c: fromC };
      this.uiMode = "idle";
      this.emit(
        shortP(atk.owner) +
          "·" +
          atk.unit +
          "#" +
          atk.id +
          ":atk " +
          shortP(tgt.owner) +
          "·" +
          tgt.unit +
          "#" +
          tgt.id +
          " " +
          rc(toR, toC) +
          " " +
          dmg +
          "→" +
          (killed ? "×" : hpLeft)
      );
      if (killed) {
        this.emit(
          shortP(atk.owner) +
            "·" +
            atk.unit +
            "#" +
            atk.id +
            ":kill +" +
            KILL_GOLD +
            " gold · move & attack available again"
        );
      }
      this.afterLocalAction();
    }

    passSelected() {
      if (!this.selected) return;
      const pc = this.pieceAt(this.selected.r, this.selected.c);
      if (!pc) return;
      this.passed.add(pc.id);
      this.clearSelection();
      this.emit(shortP(pc.owner) + "·" + pc.unit + "#" + pc.id + ":pass");
      this.afterLocalAction();
    }

    afterLocalAction() {
      this.checkGameOver();
      this.tryAutoEndTurn();
      if (this.onLocalAction) this.onLocalAction();
    }

    startOnline(seed, mapId, startingGold) {
      this.configureMap(mapId in MAPS ? mapId : "STANDARD_5X10");
      if (startingGold > 0) {
        this.startingGoldOverride = startingGold;
        this.gold = [startingGold, startingGold];
      }
      this.current = (seed & 1) === 0 ? 0 : 1;
      this.turnNumber = 0;
      this.outcome = "ongoing";
    }

    canonicalHash64() {
      let h = 0xcbf29ce484222325;
      h = fnvMix(h, this.rows);
      h = fnvMix(h, this.cols);
      h = fnvMix(h, this.startingGoldOverride);
      h = fnvMix(h, this.turnNumber);
      h = fnvMix(h, this.current);
      h = fnvMix(h, 0); // GameMode.NORMAL
      h = fnvMix(h, 0); // alternateActivationMode
      h = fnvMix(h, this.gold[0]);
      h = fnvMix(h, this.gold[1]);
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          h = fnvMix(h, this.water[r][c] ? 1 : 0);
          h = fnvMix(h, 0); // blocks
          h = fnvMix(h, 0); // mapWallBlock
          h = fnvMix(h, 0); // blockHp
          h = fnvMix(h, 0); // groundArrows
          h = fnvMix(h, 0);
          h = fnvMix(h, 0); // builderRecruit
          h = fnvMix(h, 0);
          const pc = this.grid[r][c];
          if (!pc) {
            h = fnvMix(h, 0);
          } else {
            h = fnvMix(h, 1);
            h = fnvMix(h, pc.id);
            h = fnvMix(h, pc.owner);
            h = fnvMix(h, UNITS[pc.unit].ordinal);
            h = fnvMix(h, -1); // attack override
            h = fnvMix(h, pc.tier);
            h = fnvMix(h, pc.hp);
            h = fnvMix(h, 0); // shield
            h = fnvMix(h, 0);
            h = fnvMix(h, 0); // archer arrows
            h = fnvMix(h, 0); // miner gold
            h = fnvMix(h, 0);
            h = fnvMix(h, 0); // zombified
            h = fnvMix(h, 0); // builder attacks
          }
        }
      }
      h = fnvMix(h, 0); // pending NONE
      h = fnvMix(h, 0); // turretOpeningVolleyPending
      h = fnvMix(h, this.mayPlaceThisTurn ? 1 : 0);
      h = fnvMix(h, -1); // tdP1LockedPieceId
      h = fnvMix(h, 0);
      h = fnvMix(h, 0);
      return h >>> 0 === h ? h : Number(BigInt.asUintN(64, BigInt(h)));
    }

    applyRemoteLine(line) {
      this.applyingRemote = true;
      try {
        applyActionLine(this, line, true);
      } finally {
        this.applyingRemote = false;
      }
    }
  }

  function parseActionLine(line) {
    if (!line) return false;
    line = line.trim();
    if (!line || line.startsWith("—") || line.includes(":kill +") || line.includes(":kill (")) return false;
    return (
      /:new @/.test(line) ||
      /:mv /.test(line) ||
      /:atk /.test(line) ||
      /:pass/.test(line) ||
      /:end$/.test(line)
    );
  }

  function applyActionLine(model, line, fromRemote) {
    line = line.trim();
    let m;

    m = /^(P[12])·([SG])#(\d+):new @(\d+),(\d+)$/.exec(line);
    if (m) {
      const owner = m[1] === "P1" ? 0 : 1;
      const id = +m[3];
      const r = +m[4] - 1, c = +m[5] - 1;
      model.gold[owner] -= RECRUIT_COST;
      model.grid[r][c] = model.createPiece(owner, m[2], id);
      model.placed.add(id);
      model.mayPlaceThisTurn = false;
      model.nextId = Math.max(model.nextId, id + 1);
      model.clearSelection();
      if (!fromRemote) return;
      return;
    }

    m = /^(P[12])·([SG])#(\d+):mv (\d+),(\d+)→(\d+),(\d+)$/.exec(line);
    if (m) {
      const fr = +m[4] - 1, fc = +m[5] - 1, tr = +m[6] - 1, tc = +m[7] - 1;
      const id = +m[3];
      const pc = model.pieceAt(fr, fc);
      if (pc) {
        model.grid[fr][fc] = null;
        model.grid[tr][tc] = pc;
        model.moved.add(id);
      }
      model.clearSelection();
      return;
    }

    m = /^(P[12])·([SG])#(\d+):atk P[12]·([SG])#\d+ (\d+),(\d+) \d+→/.exec(line);
    if (m) {
      const atkId = +m[3];
      const tr = +m[5] - 1, tc = +m[6] - 1;
      const killed = line.endsWith("×");
      let atkCell = null;
      for (let r = 0; r < model.rows; r++) {
        for (let c = 0; c < model.cols; c++) {
          const pc = model.grid[r][c];
          if (pc && pc.id === atkId) atkCell = { r, c, pc };
        }
      }
      const tgt = model.pieceAt(tr, tc);
      if (tgt) {
        const dmgMatch = / (\d+)→/.exec(line);
        const dmg = dmgMatch ? +dmgMatch[1] : UNITS[tgt.unit].maxHp;
        tgt.hp -= dmg;
        if (killed || tgt.hp <= 0) {
          model.grid[tr][tc] = null;
          if (atkCell) {
            model.gold[atkCell.pc.owner] += KILL_GOLD;
            model.moved.delete(atkId);
            model.attacked.delete(atkId);
          }
        } else if (atkCell) {
          model.attacked.add(atkId);
        }
      }
      model.clearSelection();
      model.checkGameOver();
      return;
    }

    m = /^(P[12])·([SG])#(\d+):pass/.exec(line);
    if (m) {
      model.passed.add(+m[3]);
      model.clearSelection();
      return;
    }

    m = /^(P[12]):end$/.exec(line);
    if (m) {
      model.moved.clear();
      model.attacked.clear();
      model.passed.clear();
      model.placed.clear();
      model.mayPlaceThisTurn = true;
      model.clearSelection();
      model.current = model.current === 0 ? 1 : 0;
      model.turnNumber++;
      model.checkGameOver();
      return;
    }
  }

  class RelaySession {
    constructor(onMessage, onFatal) {
      this.onMessage = onMessage;
      this.onFatal = onFatal;
      this.ws = null;
      this.inbox = [];
      this.waiter = null;
      this.closed = false;
      this.role = null;
      this.roomCode = "";
    }

    connect(url) {
      return new Promise((resolve, reject) => {
        this.ws = new WebSocket(url);
        this.ws.onerror = () => reject(new Error("WebSocket connection failed"));
        this.ws.onclose = (ev) => {
          if (this.closed) return;
          this.closed = true;
          const code = ev && typeof ev.code === "number" ? ev.code : 0;
          const detail = code ? " (code " + code + ")" : "";
          this.onFatal("Disconnected from relay." + detail);
        };
        this.ws.onmessage = (ev) => this.dispatch(String(ev.data).trim());
        this.recv(/^HELLO/)
          .then(() => resolve())
          .catch(reject);
      });
    }

    dispatch(msg) {
      if (!msg) return;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(msg);
        return;
      }
      this.inbox.push(msg);
    }

    recv(re) {
      return new Promise((resolve, reject) => {
        for (let i = 0; i < this.inbox.length; i++) {
          const msg = this.inbox[i];
          if (re.test(msg)) {
            this.inbox.splice(i, 1);
            resolve(msg);
            return;
          }
          if (msg.startsWith("ERR ")) {
            this.inbox.splice(i, 1);
            reject(new Error(msg));
            return;
          }
        }
        this.waiter = (msg) => {
          if (re.test(msg)) {
            this.waiter = null;
            resolve(msg);
          } else if (msg.startsWith("ERR ")) {
            this.waiter = null;
            reject(new Error(msg));
          } else {
            this.inbox.push(msg);
          }
        };
      });
    }

    send(msg) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(msg);
    }

    close() {
      this.closed = true;
      if (this.ws) this.ws.close();
    }

    async host() {
      this.send("CREATE_ROOM");
      const room = await this.recv(/^ROOM /);
      this.parseRoom(room);
    }

    async join(code) {
      this.send("JOIN_ROOM " + code.trim().toUpperCase());
      const room = await this.recv(/^ROOM /);
      this.parseRoom(room);
    }

    parseRoom(line) {
      const parts = line.trim().split(/\s+/);
      this.roomCode = parts[1] || "";
      let roleStr = "guest";
      for (let i = 2; i + 1 < parts.length; i++) {
        if (parts[i].toUpperCase() === "ROLE") {
          roleStr = parts[i + 1];
          break;
        }
      }
      this.role = /^host$/i.test(roleStr) ? "host" : "guest";
    }

    pump() {
      const drain = () => {
        while (this.inbox.length) {
          const msg = this.inbox.shift();
          if (msg.startsWith("HELLO")) continue;
          try {
            this.onMessage(msg);
          } catch (err) {
            console.error("Strame message handler error:", err);
          }
        }
      };
      this._drain = drain;
      const orig = this.dispatch.bind(this);
      this.dispatch = (msg) => {
        orig(msg);
        drain();
      };
      drain();
    }
  }

  function renderBoard(canvas, model, seat, highlights) {
    const ctx = canvas.getContext("2d");
    const cell = Math.min(
      Math.floor((canvas.clientWidth || 640) / model.cols),
      Math.floor(420 / model.rows)
    );
    const w = cell * model.cols;
    const h = cell * model.rows;
    canvas.width = w;
    canvas.height = h;

    ctx.clearRect(0, 0, w, h);
    for (let r = 0; r < model.rows; r++) {
      for (let c = 0; c < model.cols; c++) {
        const x = c * cell, y = r * cell;
        ctx.fillStyle = model.water[r][c] ? "#7eb6e6" : (r + c) % 2 ? "#e8ebf2" : "#dfe3ec";
        ctx.fillRect(x, y, cell, cell);
        if (c === model.homeCol(0)) {
          ctx.fillStyle = "rgba(56,97,240,0.08)";
          ctx.fillRect(x, y, cell, cell);
        }
        if (c === model.homeCol(1)) {
          ctx.fillStyle = "rgba(224,69,69,0.08)";
          ctx.fillRect(x, y, cell, cell);
        }
      }
    }

    for (const hl of highlights || []) {
      ctx.fillStyle = hl.kind === "move" ? "rgba(56,97,240,0.28)" : "rgba(224,69,69,0.28)";
      ctx.fillRect(hl.c * cell, hl.r * cell, cell, cell);
    }

    if (model.selected) {
      ctx.strokeStyle = "#f5c518";
      ctx.lineWidth = 3;
      ctx.strokeRect(
        model.selected.c * cell + 2,
        model.selected.r * cell + 2,
        cell - 4,
        cell - 4
      );
    }

    for (let r = 0; r < model.rows; r++) {
      for (let c = 0; c < model.cols; c++) {
        const pc = model.grid[r][c];
        if (!pc) continue;
        const cx = c * cell + cell / 2;
        const cy = r * cell + cell / 2;
        const rad = cell * 0.34;
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fillStyle = pc.owner === 0 ? "#3861f0" : "#e04545";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.font = `bold ${Math.floor(cell * 0.34)}px system-ui,sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(pc.unit, cx, cy - 1);
        ctx.font = `${Math.floor(cell * 0.22)}px system-ui,sans-serif`;
        ctx.fillText(String(pc.hp), cx, cy + cell * 0.22);
      }
    }
  }

  function mount(selector, options) {
    options = options || {};
    const root =
      typeof selector === "string" ? document.querySelector(selector) : selector;
    if (!root) throw new Error("StrameWeb.mount: container not found");

    root.classList.add("strame-web-root");
    root.innerHTML = `
      <div class="strame-web-header">
        <h1>Strame Online</h1>
        <div class="strame-web-status" data-status>Offline</div>
      </div>
      <p class="strame-web-note">Browser client (Soldier &amp; Gollem, preset maps). Run the desktop app separately for full features.</p>
      <div class="strame-web-panel" data-lobby>
        <h2>Connect</h2>
        <div class="strame-web-row">
          <label>Relay URL</label>
          <input type="text" class="wide" data-relay value="${escapeHtml(options.relayUrl || DEFAULT_RELAY)}" placeholder="${RELAY_PLACEHOLDER}">
        </div>
        <div class="strame-web-row">
          <label>Your name</label>
          <input type="text" data-name maxlength="32" placeholder="Player">
        </div>
        <div class="strame-web-lobby-actions">
          <section class="strame-web-lobby-card strame-web-lobby-card--host">
            <h3>Host a game</h3>
            <p class="strame-web-lobby-lead">Create a room and share the code with your opponent.</p>
            <div class="strame-web-field">
              <label for="strame-map-select">Map</label>
              <select id="strame-map-select" data-map>
                <option value="STANDARD_5X10">Standard 5×10</option>
                <option value="RIVER_5X10">5×10 River</option>
              </select>
            </div>
            <button type="button" class="primary-host block" data-host>Host game</button>
            <p class="strame-web-hint">If the relay times out while you wait, click Host game again for a new code.</p>
          </section>
          <p class="strame-web-lobby-or" aria-hidden="true">or</p>
          <section class="strame-web-lobby-card strame-web-lobby-card--guest">
            <h3>Join as guest</h3>
            <p class="strame-web-lobby-lead">Enter the room code from the host to play as Player 2.</p>
            <div class="strame-web-field">
              <label for="strame-room-code">Room code</label>
              <input id="strame-room-code" type="text" data-code maxlength="12" placeholder="ABCDEF" autocomplete="off" spellcheck="false">
            </div>
            <button type="button" class="primary-guest block" data-join>Join game</button>
            <p class="strame-web-hint">Use the same relay URL as the host.</p>
          </section>
        </div>
      </div>
      <div class="strame-web-banner strame-web-hidden" data-banner></div>
      <div class="strame-web-game strame-web-hidden" data-game>
        <div class="strame-web-board-wrap">
          <canvas data-canvas width="600" height="300" aria-label="Strame board"></canvas>
        </div>
        <div class="strame-web-sidebar">
          <div class="strame-web-stat" data-stats></div>
          <div class="strame-web-row">
            <button type="button" data-mode-recruit>Recruit</button>
            <select data-unit>
              <option value="S">Soldier</option>
              <option value="G">Gollem</option>
            </select>
          </div>
          <div class="strame-web-row">
            <button type="button" data-move>Move</button>
            <button type="button" data-attack>Attack</button>
            <button type="button" data-pass>Pass</button>
            <button type="button" data-end>End turn</button>
          </div>
          <div class="strame-web-log" data-log></div>
        </div>
      </div>
    `;

    const el = {
      status: root.querySelector("[data-status]"),
      lobby: root.querySelector("[data-lobby]"),
      game: root.querySelector("[data-game]"),
      banner: root.querySelector("[data-banner]"),
      canvas: root.querySelector("[data-canvas]"),
      stats: root.querySelector("[data-stats]"),
      log: root.querySelector("[data-log]"),
      relay: root.querySelector("[data-relay]"),
      map: root.querySelector("[data-map]"),
      name: root.querySelector("[data-name]"),
      code: root.querySelector("[data-code]"),
      unit: root.querySelector("[data-unit]"),
    };

    const model = new GameModel();
    let online = null;
    let seat = null; // 0 host, 1 guest
    let pendingHashTurn = -1;
    let pendingHash = 0;
    let matchSeed = 0;
    let matchMap = "STANDARD_5X10";
    let matchStarted = false;
    let keepaliveTimer = null;

    function stopKeepalive() {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
    }

    function startKeepalive() {
      stopKeepalive();
      keepaliveTimer = setInterval(() => {
        if (online && !online.closed) {
          online.send("PING");
        }
      }, 15000);
    }

    function onRelayFatal(msg) {
      handleRelayDisconnect(msg);
    }

    function resetToLobby(options) {
      options = options || {};
      el.lobby.classList.remove("strame-web-hidden");
      el.game.classList.add("strame-web-hidden");
      el.banner.classList.remove("win");
      if (options.clearRoomCode) {
        el.code.value = "";
      }
      if (options.clearLog) {
        el.log.textContent = "";
      }
    }

    function handleRelayDisconnect(msg) {
      stopKeepalive();
      const wasSeat = seat;
      const wasInMatch = matchStarted;
      const oldRoom = online ? online.roomCode : el.code.value.trim();

      if (online) {
        online.closed = true;
        online = null;
      }
      seat = null;
      matchStarted = false;

      resetToLobby({ clearRoomCode: wasSeat === 0 && !wasInMatch, clearLog: wasInMatch });

      el.banner.classList.remove("strame-web-hidden");
      el.banner.classList.add("error");

      if (wasSeat === 0 && !wasInMatch) {
        el.banner.textContent =
          "Connection to the relay was lost while waiting for a guest" +
          (oldRoom ? " (room " + oldRoom + ")" : "") +
          ". The room has been cleared on the server. Click Host game again to create a new room and share a fresh code.";
        setStatus("Not connected — click Host game");
        return;
      }

      if (wasSeat === 1 && !wasInMatch) {
        el.banner.textContent =
          "Connection to the relay was lost before the match started. " +
          "Ask the host for a new room code, then click Join game again.";
        setStatus("Not connected — click Join game");
        return;
      }

      el.banner.textContent =
        "Disconnected from relay. The match has ended — use Host game or Join game to play again.";
      setStatus("Not connected");
    }

    function handleOpponentDisconnected() {
      if (!matchStarted && seat === 0 && online) {
        setStatus("Guest left — still hosting room " + online.roomCode);
        el.banner.classList.add("strame-web-hidden");
        return;
      }
      stopKeepalive();
      const wasInMatch = matchStarted;
      if (online) {
        online.close();
        online = null;
      }
      seat = null;
      matchStarted = false;
      resetToLobby({ clearLog: wasInMatch });
      el.banner.classList.remove("strame-web-hidden");
      el.banner.classList.add("error");
      el.banner.textContent = wasInMatch
        ? "Opponent disconnected. The match has ended — use Host game or Join game to play again."
        : "Opponent disconnected before the match started. Click Join game again when the host is ready.";
      setStatus("Not connected");
    }

    function setStatus(t) {
      el.status.textContent = t;
    }

    function log(line) {
      el.log.textContent = (el.log.textContent + line + "\n").slice(-4000);
      el.log.scrollTop = el.log.scrollHeight;
    }

    function escapeHtml(s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    }

    function myTurn() {
      return seat !== null && model.current === seat && model.outcome === "ongoing";
    }

    function highlights() {
      const out = [];
      if (!myTurn() || !model.selected) return out;
      if (model.uiMode === "move") {
        for (const t of model.legalMoveTargets(model.selected.r, model.selected.c)) {
          out.push({ r: t.r, c: t.c, kind: "move" });
        }
      } else if (model.uiMode === "attack") {
        for (const t of model.legalAttackTargets(model.selected.r, model.selected.c)) {
          out.push({ r: t.r, c: t.c, kind: "attack" });
        }
      } else if (model.uiMode === "recruit") {
        for (let r = 0; r < model.rows; r++) {
          const c = model.homeCol(seat);
          if (model.canRecruitAt(r, c)) out.push({ r, c, kind: "move" });
        }
      }
      return out;
    }

    function refresh() {
      renderBoard(el.canvas, model, seat, highlights());
      const names = ["You (P1)", "Opponent (P2)"];
      if (seat === 1) names.reverse();
      el.stats.innerHTML =
        `<strong>Room:</strong> ${online ? online.roomCode : "—"}<br>` +
        `<strong>You:</strong> ${seat === 0 ? "P1 (host)" : "P2 (guest)"}<br>` +
        `<strong>Turn:</strong> ${model.turnNumber} · ${model.current === 0 ? "P1" : "P2"}<br>` +
        `<strong>Gold:</strong> P1 ${model.gold[0]} · P2 ${model.gold[1]}<br>` +
        `<strong>Map:</strong> ${MAPS[matchMap]?.label || matchMap}`;
      const buttons = root.querySelectorAll("[data-move],[data-attack],[data-pass],[data-end],[data-mode-recruit]");
      buttons.forEach((b) => (b.disabled = !myTurn()));
      if (model.outcome !== "ongoing") {
        el.banner.classList.remove("strame-web-hidden");
        el.banner.classList.add("win");
        el.banner.textContent =
          model.outcome === "draw"
            ? "Draw."
            : model.outcome === (seat === 0 ? "p1" : "p2")
              ? "You win!"
              : "You lose.";
      }
    }

    function sendAction(line) {
      if (!online) return;
      online.send("ACTION " + model.turnNumber + " " + shortP(model.current) + " " + line);
      log("→ " + line);
    }

    model.actionHook = (line) => sendAction(line);
    model.onLocalAction = () => refresh();
    model.onTurnEnded = () => {
      if (!online) return;
      const h = model.canonicalHash64();
      online.send("HASH " + model.turnNumber + " " + (h >>> 0).toString());
      refresh();
    };

    function handleNetwork(msg) {
      if (msg === "READY") {
        setStatus("Both players connected");
        if (seat === 0 && !matchStarted) {
          const seed = Date.now();
          const mapId = matchMap;
          online.send("START " + seed + " " + mapId);
          startMatch(seed, mapId, 0, false);
        }
        return;
      }
      if (msg.startsWith("START ")) {
        if (matchStarted) return;
        const parts = msg.trim().split(/\s+/);
        const seed = +parts[1];
        let mapId = "STANDARD_5X10";
        if (parts.length >= 3) {
          const end = parts.length;
          let mapEnd = end;
          if (parts[end - 1] === "R1") mapEnd--;
          if (mapEnd > 2 && /^S\d+$/i.test(parts[mapEnd - 1])) mapEnd--;
          mapId = parts.slice(2, mapEnd).join(" ") || "STANDARD_5X10";
        }
        startMatch(seed, mapId, 0, msg.includes("R1"));
        return;
      }
      if (msg.startsWith("PEERNAME ")) {
        return;
      }
      if (msg.startsWith("ACTION ")) {
        const parts = msg.split(/\s+/);
        const actor = parts[2];
        const myActor = seat === 0 ? "P1" : "P2";
        if (actor === myActor) return;
        const rest = parts.slice(3).join(" ");
        model.applyRemoteLine(rest);
        log("← " + rest);
        refresh();
        return;
      }
      if (msg.startsWith("HASH ")) {
        const p = msg.split(/\s+/);
        pendingHashTurn = +p[1];
        pendingHash = +p[2];
        if (pendingHashTurn === model.turnNumber) compareHash();
        return;
      }
      if (msg === "PEER_DISCONNECTED") {
        handleOpponentDisconnected();
        return;
      }
      if (msg.startsWith("WAITING_")) setStatus(msg);
    }

    function compareHash() {
      const local = model.canonicalHash64() >>> 0;
      if (local !== (pendingHash >>> 0)) {
        showError("Desync detected (hash mismatch).");
      }
      pendingHashTurn = -1;
    }

    function startMatch(seed, mapId, gold, rematch) {
      matchStarted = true;
      matchSeed = seed;
      matchMap = mapId in MAPS ? mapId : "STANDARD_5X10";
      model.startOnline(seed, matchMap, gold);
      el.lobby.classList.add("strame-web-hidden");
      el.game.classList.remove("strame-web-hidden");
      setStatus(rematch ? "Rematch started" : "Match in progress");
      log("— Match start seed " + seed + " map " + matchMap);
      refresh();
    }

    function showError(msg) {
      el.banner.classList.remove("strame-web-hidden");
      el.banner.classList.add("error");
      el.banner.textContent = msg;
      setStatus(msg);
    }

    async function connectOnline(asHost) {
      try {
        const url = el.relay.value.trim();
        if (!url) {
          throw new Error("Enter a relay URL (e.g. " + RELAY_PLACEHOLDER + ")");
        }
        if (!/^wss?:\/\//i.test(url)) {
          throw new Error("Relay URL must start with ws:// or wss://");
        }
        if (online) {
          online.close();
          online = null;
        }
        stopKeepalive();
        matchStarted = false;
        matchMap = el.map.value;
        online = new RelaySession(handleNetwork, onRelayFatal);
        await online.connect(url);
        setStatus("Connected to relay");
        if (asHost) {
          await online.host();
          seat = online.role === "host" ? 0 : 1;
          if (seat !== 0) throw new Error("Relay did not assign host role");
          el.code.value = online.roomCode;
          setStatus("Room " + online.roomCode + " — share code with opponent");
        } else {
          const code = el.code.value.trim();
          if (!code) throw new Error("Enter a room code");
          await online.join(code);
          seat = online.role === "host" ? 0 : 1;
          if (seat !== 1) throw new Error("Relay did not assign guest role");
          setStatus("Joined room " + online.roomCode);
        }
        online.pump();
        startKeepalive();
        const name = el.name.value.trim();
        if (name) {
          online.send("PEERNAME " + btoa(unescape(encodeURIComponent(name))));
        }
      } catch (e) {
        stopKeepalive();
        showError(e.message || String(e));
        if (online) online.close();
        online = null;
      }
    }

    root.querySelector("[data-host]").addEventListener("click", () => connectOnline(true));
    root.querySelector("[data-join]").addEventListener("click", () => connectOnline(false));

    root.querySelector("[data-mode-recruit]").addEventListener("click", () => {
      if (!myTurn()) return;
      model.uiMode = model.uiMode === "recruit" ? "idle" : "recruit";
      model.clearSelection();
      refresh();
    });

    root.querySelector("[data-move]").addEventListener("click", () => {
      if (!myTurn() || !model.selected) return;
      model.uiMode = "move";
      refresh();
    });

    root.querySelector("[data-attack]").addEventListener("click", () => {
      if (!myTurn() || !model.selected) return;
      model.uiMode = "attack";
      refresh();
    });

    root.querySelector("[data-pass]").addEventListener("click", () => {
      if (!myTurn()) return;
      model.passSelected();
      refresh();
    });

    root.querySelector("[data-end]").addEventListener("click", () => {
      if (!myTurn()) return;
      model.endTurnEarly();
      refresh();
    });

    el.unit.addEventListener("change", () => {
      model.recruitUnit = el.unit.value;
    });

    el.canvas.addEventListener("click", (ev) => {
      if (!myTurn()) return;
      const rect = el.canvas.getBoundingClientRect();
      const cellW = el.canvas.width / model.cols;
      const cellH = el.canvas.height / model.rows;
      const c = Math.floor(((ev.clientX - rect.left) / rect.width) * el.canvas.width / cellW);
      const r = Math.floor(((ev.clientY - rect.top) / rect.height) * el.canvas.height / cellH);
      if (r < 0 || c < 0 || r >= model.rows || c >= model.cols) return;

      if (model.uiMode === "recruit") {
        model.recruit(model.recruitUnit, r, c);
        model.uiMode = "idle";
        refresh();
        return;
      }
      if (model.uiMode === "move" && model.selected) {
        model.moveTo(model.selected.r, model.selected.c, r, c);
        refresh();
        return;
      }
      if (model.uiMode === "attack" && model.selected) {
        model.attack(model.selected.r, model.selected.c, r, c);
        refresh();
        return;
      }
      model.select(r, c);
      refresh();
    });

    window.addEventListener("resize", () => refresh());
    refresh();
  }

  global.StrameWeb = { mount, GameModel, MAPS, UNITS };
})(typeof window !== "undefined" ? window : globalThis);
