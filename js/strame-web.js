/**
 * Strame thin web client — Standard Online (browser vs browser).
 * Embed: StrameWeb.mount("#container", { relayUrl: "wss://…/ws" });
 */
(function (global) {
  "use strict";

  const WEB_CLIENT_VERSION = "20260707-lobby-ui";
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

    clearPieceSelection() {
      this.selected = null;
    }

    resetActionMode() {
      this.selected = null;
      this.uiMode = "idle";
    }

    /** @deprecated use clearPieceSelection or resetActionMode */
    clearSelection(resetMode) {
      if (resetMode === false) this.clearPieceSelection();
      else this.resetActionMode();
    }

    select(r, c) {
      const pc = this.pieceAt(r, c);
      if (!pc || pc.owner !== this.current || !this.pieceNeedsAction(pc)) {
        if (this.uiMode === "recruit") this.clearPieceSelection();
        else this.resetActionMode();
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
      this.resetActionMode();
      this.current = this.current === 0 ? 1 : 0;
      this.turnNumber++;
      this.checkGameOver();
      if (!this.applyingRemote && this.onTurnEnded) this.onTurnEnded();
    }

    endTurnEarly() {
      if (this.countPieces(this.current) === 0) return false;
      this.finishTurn();
      return true;
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
      if (!this.canRecruitAt(r, c)) return false;
      const id = this.nextId++;
      const pc = this.createPiece(this.current, unitKey, id);
      this.gold[this.current] -= RECRUIT_COST;
      this.grid[r][c] = pc;
      this.placed.add(id);
      this.mayPlaceThisTurn = false;
      this.resetActionMode();
      this.emit(shortP(this.current) + "·" + pc.unit + "#" + id + ":new @" + rc(r, c));
      this.afterLocalAction();
      return true;
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
      this.resetActionMode();
      this.emit(shortP(pc.owner) + "·" + pc.unit + "#" + pc.id + ":pass");
      this.afterLocalAction();
    }

    afterLocalAction() {
      this.checkGameOver();
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
      model.resetActionMode();
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
      model.resetActionMode();
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
      model.resetActionMode();
      return;
    }

    m = /^(P[12])·([SG])#(\d+):pass/.exec(line);
    if (m) {
      model.passed.add(+m[3]);
      model.resetActionMode();
      return;
    }

    m = /^(P[12]):end$/.exec(line);
    if (m) {
      model.moved.clear();
      model.attacked.clear();
      model.passed.clear();
      model.placed.clear();
      model.mayPlaceThisTurn = true;
      model.resetActionMode();
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

  function loadImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  function resolveAssetBase(options) {
    const raw = (options && options.assetBase) || "assets/strame/";
    try {
      const url = new URL(raw, document.location.href);
      return url.href.endsWith("/") ? url.href : url.href + "/";
    } catch (_) {
      return raw.endsWith("/") ? raw : raw + "/";
    }
  }

  async function loadAssets(base) {
    const root = base.endsWith("/") ? base : base + "/";
    const [tile, soldier, gollem] = await Promise.all([
      loadImage(root + "tile.png"),
      loadImage(root + "soldier1.png"),
      loadImage(root + "gollem1.png"),
    ]);
    if (!soldier || !gollem) {
      console.warn("StrameWeb: character sprites failed to load from", root);
    }
    return { tile, soldier, gollem, ready: !!(soldier && gollem) };
  }

  function drawTintedSprite(ctx, img, x, y, w, h, owner) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const pad = Math.max(2, Math.floor(Math.min(w, h) * 0.06));
    const dx = x + pad;
    const dy = y + pad;
    const dw = w - pad * 2;
    const dh = h - pad * 2;
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.strokeStyle = owner === 0 ? "#3861f0" : "#e04545";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.restore();
  }

  function renderBoard(canvas, model, seat, highlights, assets) {
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
        if (assets && assets.tile) {
          ctx.drawImage(assets.tile, x, y, cell, cell);
        } else {
          ctx.fillStyle = (r + c) % 2 ? "#e8ebf2" : "#dfe3ec";
          ctx.fillRect(x, y, cell, cell);
        }
        if (model.water[r][c]) {
          ctx.fillStyle = "rgba(126,182,230,0.72)";
          ctx.fillRect(x, y, cell, cell);
        }
        if (c === model.homeCol(0)) {
          ctx.fillStyle = "rgba(56,97,240,0.12)";
          ctx.fillRect(x, y, cell, cell);
        }
        if (c === model.homeCol(1)) {
          ctx.fillStyle = "rgba(224,69,69,0.12)";
          ctx.fillRect(x, y, cell, cell);
        }
      }
    }

    for (const hl of highlights || []) {
      ctx.fillStyle =
        hl.kind === "recruit"
          ? "rgba(22,163,74,0.38)"
          : hl.kind === "move"
            ? "rgba(56,97,240,0.28)"
            : "rgba(224,69,69,0.28)";
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
        const x = c * cell;
        const y = r * cell;
        const sprite =
          assets && (pc.unit === "G" ? assets.gollem : assets.soldier);
        if (sprite) {
          drawTintedSprite(ctx, sprite, x, y, cell, cell, pc.owner);
        } else {
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
        }
        const cx = c * cell + cell / 2;
        const hpY = (r + 1) * cell - Math.max(4, Math.floor(cell * 0.12));
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#1a1f28";
        ctx.lineWidth = 2;
        ctx.font = `bold ${Math.max(10, Math.floor(cell * 0.22))}px system-ui,sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.strokeText(String(pc.hp), cx, hpY);
        ctx.fillText(String(pc.hp), cx, hpY);
      }
    }
  }

  function mount(selector, options) {
    options = options || {};
    const root =
      typeof selector === "string" ? document.querySelector(selector) : selector;
    if (!root) throw new Error("StrameWeb.mount: container not found");

    function escapeHtml(s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    }

    root.classList.add("strame-web-root");
    root.innerHTML = `
      <div class="strame-web-lobby-shell" data-lobby>
        <header class="strame-web-lobby-hero">
          <div class="strame-web-lobby-brand">
            <h1>Strame Online</h1>
            <span class="strame-web-version-badge">v${WEB_CLIENT_VERSION}</span>
          </div>
          <p class="strame-web-lobby-tagline">Standard Online · Soldier &amp; Gollem</p>
          <div class="strame-web-status-pill" data-status-pill>
            <span class="strame-web-status-dot is-idle" data-status-dot aria-hidden="true"></span>
            <span class="strame-web-status-text" data-status>Loading…</span>
          </div>
        </header>

        <div class="strame-web-party" data-party aria-label="Lobby players">
          <div class="strame-web-party-slot is-you" data-slot-you>
            <div class="strame-web-party-avatar" aria-hidden="true">1</div>
            <div class="strame-web-party-meta">
              <span class="strame-web-party-label">Player 1</span>
              <strong class="strame-web-party-name" data-slot-you-name>You</strong>
              <span class="strame-web-party-state" data-slot-you-state>Offline</span>
            </div>
          </div>
          <div class="strame-web-party-vs" aria-hidden="true">VS</div>
          <div class="strame-web-party-slot is-empty" data-slot-opp>
            <div class="strame-web-party-avatar" aria-hidden="true">2</div>
            <div class="strame-web-party-meta">
              <span class="strame-web-party-label">Player 2</span>
              <strong class="strame-web-party-name" data-slot-opp-name>Waiting…</strong>
              <span class="strame-web-party-state" data-slot-opp-state>Empty slot</span>
            </div>
          </div>
        </div>

        <div class="strame-web-player-bar">
          <label for="strame-display-name">Display name</label>
          <input id="strame-display-name" type="text" data-name maxlength="32" placeholder="Enter your name" autocomplete="nickname">
        </div>

        <div class="strame-web-mode-tabs" role="tablist" aria-label="Lobby mode">
          <button type="button" class="strame-web-mode-tab is-active" role="tab" id="strame-tab-host" data-tab-host aria-selected="true" aria-controls="strame-panel-host">Create lobby</button>
          <button type="button" class="strame-web-mode-tab" role="tab" id="strame-tab-join" data-tab-join aria-selected="false" aria-controls="strame-panel-join">Join game</button>
        </div>

        <section class="strame-web-mode-panel" id="strame-panel-host" role="tabpanel" aria-labelledby="strame-tab-host" data-panel-host>
          <div class="strame-web-field">
            <label for="strame-map-select">Map</label>
            <select id="strame-map-select" data-map>
              <option value="STANDARD_5X10">Standard 5×10</option>
              <option value="RIVER_5X10">5×10 River</option>
            </select>
          </div>
          <div class="strame-web-room-reveal strame-web-hidden" data-room-reveal>
            <p class="strame-web-room-reveal-label">Room code — share with your opponent</p>
            <div class="strame-web-room-code-row">
              <output class="strame-web-room-code" data-room-code for="strame-room-code">------</output>
              <button type="button" class="strame-web-copy-btn" data-copy-code>Copy</button>
            </div>
          </div>
          <button type="button" class="strame-web-play-btn strame-web-play-btn--host" data-host>
            <span class="strame-web-play-btn-label" data-host-label>Create lobby</span>
          </button>
          <p class="strame-web-hint">Host creates the room and shares the code. Match starts when both players connect.</p>
        </section>

        <section class="strame-web-mode-panel strame-web-hidden" id="strame-panel-join" role="tabpanel" aria-labelledby="strame-tab-join" data-panel-join hidden>
          <div class="strame-web-field">
            <label for="strame-room-code">Room code</label>
            <input id="strame-room-code" class="strame-web-room-input" type="text" data-code maxlength="12" placeholder="ABCDEF" autocomplete="off" spellcheck="false" inputmode="text">
          </div>
          <button type="button" class="strame-web-play-btn strame-web-play-btn--join" data-join>
            <span class="strame-web-play-btn-label" data-join-label>Join game</span>
          </button>
          <p class="strame-web-hint">Use the same relay server as the host. Codes are not case-sensitive.</p>
        </section>

        <details class="strame-web-advanced">
          <summary>Connection settings</summary>
          <div class="strame-web-field">
            <label for="strame-relay-url">Relay server</label>
            <input id="strame-relay-url" type="text" class="wide" data-relay value="${escapeHtml(options.relayUrl || DEFAULT_RELAY)}" placeholder="${RELAY_PLACEHOLDER}" spellcheck="false">
            <p class="strame-web-advanced-note">Both players must use the exact same WebSocket relay URL.</p>
          </div>
        </details>
      </div>
      <div class="strame-web-banner strame-web-hidden" data-banner></div>
      <div class="strame-web-game strame-web-hidden" data-game>
        <div class="strame-web-match-bar">
          <div class="strame-web-player-card strame-web-player-you" data-you-card>
            <span class="strame-web-player-label">You</span>
            <strong class="strame-web-player-role" data-you-role>—</strong>
            <span class="strame-web-player-side" data-you-side>—</span>
            <span class="strame-web-player-gold" data-your-gold>Gold: —</span>
          </div>
          <div class="strame-web-turn-pill" data-turn-pill>Connecting…</div>
          <div class="strame-web-player-card strame-web-player-opp" data-opp-card>
            <span class="strame-web-player-label">Opponent</span>
            <strong class="strame-web-player-role" data-opp-role>—</strong>
            <span class="strame-web-player-side" data-opp-side>—</span>
            <span class="strame-web-player-gold" data-opp-gold>Gold: —</span>
          </div>
        </div>
        <div class="strame-web-board-wrap">
          <canvas data-canvas width="600" height="300" aria-label="Strame board"></canvas>
        </div>
        <div class="strame-web-actions" data-actions>
          <p class="strame-web-actions-hint" data-actions-hint></p>
          <div class="strame-web-actions-row">
            <button type="button" class="action-btn" data-mode-recruit>Recruit</button>
            <select data-unit aria-label="Unit to recruit">
              <option value="S">Soldier</option>
              <option value="G">Gollem</option>
            </select>
          </div>
          <div class="strame-web-actions-row">
            <button type="button" class="action-btn" data-move>Move</button>
            <button type="button" class="action-btn" data-attack>Attack</button>
            <button type="button" class="action-btn" data-pass>Pass</button>
          </div>
          <button type="button" class="end-turn-btn block" data-end>End turn</button>
        </div>
        <details class="strame-web-log-panel" open>
          <summary>Battle log</summary>
          <div class="strame-web-log" data-log></div>
        </details>
      </div>
    `;

    const el = {
      status: root.querySelector("[data-status]"),
      statusDot: root.querySelector("[data-status-dot]"),
      statusPill: root.querySelector("[data-status-pill]"),
      lobby: root.querySelector("[data-lobby]"),
      game: root.querySelector("[data-game]"),
      banner: root.querySelector("[data-banner]"),
      canvas: root.querySelector("[data-canvas]"),
      log: root.querySelector("[data-log]"),
      youRole: root.querySelector("[data-you-role]"),
      youSide: root.querySelector("[data-you-side]"),
      yourGold: root.querySelector("[data-your-gold]"),
      oppRole: root.querySelector("[data-opp-role]"),
      oppSide: root.querySelector("[data-opp-side]"),
      oppGold: root.querySelector("[data-opp-gold]"),
      turnPill: root.querySelector("[data-turn-pill]"),
      actionsHint: root.querySelector("[data-actions-hint]"),
      actions: root.querySelector("[data-actions]"),
      recruitBtn: root.querySelector("[data-mode-recruit]"),
      moveBtn: root.querySelector("[data-move]"),
      attackBtn: root.querySelector("[data-attack]"),
      passBtn: root.querySelector("[data-pass]"),
      endBtn: root.querySelector("[data-end]"),
      relay: root.querySelector("[data-relay]"),
      map: root.querySelector("[data-map]"),
      name: root.querySelector("[data-name]"),
      code: root.querySelector("[data-code]"),
      unit: root.querySelector("[data-unit]"),
      tabHost: root.querySelector("[data-tab-host]"),
      tabJoin: root.querySelector("[data-tab-join]"),
      panelHost: root.querySelector("[data-panel-host]"),
      panelJoin: root.querySelector("[data-panel-join]"),
      hostBtn: root.querySelector("[data-host]"),
      joinBtn: root.querySelector("[data-join]"),
      hostLabel: root.querySelector("[data-host-label]"),
      joinLabel: root.querySelector("[data-join-label]"),
      roomReveal: root.querySelector("[data-room-reveal]"),
      roomCode: root.querySelector("[data-room-code]"),
      copyCode: root.querySelector("[data-copy-code]"),
      slotYou: root.querySelector("[data-slot-you]"),
      slotOpp: root.querySelector("[data-slot-opp]"),
      slotYouName: root.querySelector("[data-slot-you-name]"),
      slotYouState: root.querySelector("[data-slot-you-state]"),
      slotOppName: root.querySelector("[data-slot-opp-name]"),
      slotOppState: root.querySelector("[data-slot-opp-state]"),
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
    let sprites = null;
    const assetBase = resolveAssetBase(options);

    loadAssets(assetBase).then((loaded) => {
      sprites = loaded;
      if (matchStarted) refresh();
    });

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
        updateRoomCodeDisplay("");
      }
      if (options.clearLog) {
        el.log.textContent = "";
      }
      setLobbyConnecting(false);
      updatePartySlots();
    }

    function displayName() {
      const n = el.name && el.name.value.trim();
      return n || "Player";
    }

    function setLobbyMode(mode) {
      const isHost = mode === "host";
      if (el.panelHost) {
        el.panelHost.classList.toggle("strame-web-hidden", !isHost);
        el.panelHost.hidden = !isHost;
      }
      if (el.panelJoin) {
        el.panelJoin.classList.toggle("strame-web-hidden", isHost);
        el.panelJoin.hidden = isHost;
      }
      if (el.tabHost) {
        el.tabHost.classList.toggle("is-active", isHost);
        el.tabHost.setAttribute("aria-selected", isHost ? "true" : "false");
      }
      if (el.tabJoin) {
        el.tabJoin.classList.toggle("is-active", !isHost);
        el.tabJoin.setAttribute("aria-selected", isHost ? "false" : "true");
      }
    }

    function setConnectionVisual(state) {
      if (!el.statusDot) return;
      el.statusDot.className = "strame-web-status-dot is-" + state;
      if (el.statusPill) {
        el.statusPill.classList.remove(
          "is-idle",
          "is-ready",
          "is-connecting",
          "is-online",
          "is-waiting",
          "is-error"
        );
        el.statusPill.classList.add("is-" + state);
      }
    }

    function updateRoomCodeDisplay(code) {
      const text = (code || "").trim().toUpperCase();
      if (el.roomCode) el.roomCode.textContent = text || "------";
      if (el.roomReveal) el.roomReveal.classList.toggle("strame-web-hidden", !text);
    }

    function updatePartySlots() {
      const youName = displayName();
      if (el.slotYouName) el.slotYouName.textContent = youName;

      if (!online || online.closed) {
        if (el.slotYou) el.slotYou.classList.remove("is-connected");
        if (el.slotOpp) {
          el.slotOpp.classList.add("is-empty");
          el.slotOpp.classList.remove("is-connected", "is-waiting");
        }
        if (el.slotYouState) el.slotYouState.textContent = "Offline";
        if (el.slotOppName) el.slotOppName.textContent = "Waiting…";
        if (el.slotOppState) el.slotOppState.textContent = "Empty slot";
        return;
      }

      if (el.slotYou) el.slotYou.classList.add("is-connected");
      if (seat === 0) {
        if (el.slotYouState) el.slotYouState.textContent = "Host · Connected";
        if (el.slotOppName) el.slotOppName.textContent = "Opponent";
        if (el.slotOppState) {
          el.slotOppState.textContent = matchStarted ? "In match" : "Waiting to join…";
        }
        if (el.slotOpp) {
          el.slotOpp.classList.toggle("is-empty", false);
          el.slotOpp.classList.toggle("is-waiting", !matchStarted);
          el.slotOpp.classList.toggle("is-connected", matchStarted);
        }
      } else if (seat === 1) {
        if (el.slotYouState) el.slotYouState.textContent = "Guest · Connected";
        if (el.slotOppName) el.slotOppName.textContent = "Host";
        if (el.slotOppState) {
          el.slotOppState.textContent = matchStarted ? "In match" : "In lobby";
        }
        if (el.slotOpp) {
          el.slotOpp.classList.remove("is-empty", "is-waiting");
          el.slotOpp.classList.add("is-connected");
        }
      }
    }

    function setLobbyConnecting(active) {
      if (el.hostBtn) el.hostBtn.disabled = active;
      if (el.joinBtn) el.joinBtn.disabled = active;
      if (el.tabHost) el.tabHost.disabled = active;
      if (el.tabJoin) el.tabJoin.disabled = active;
      if (active) {
        setConnectionVisual("connecting");
        if (el.hostLabel) el.hostLabel.textContent = "Connecting…";
        if (el.joinLabel) el.joinLabel.textContent = "Connecting…";
      } else {
        if (el.hostLabel) el.hostLabel.textContent = "Create lobby";
        if (el.joinLabel) el.joinLabel.textContent = "Join game";
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

    function setStatus(t, connectionState) {
      el.status.textContent = t;
      if (connectionState) {
        setConnectionVisual(connectionState);
      } else if (/connect|loading/i.test(t)) {
        setConnectionVisual("connecting");
      } else if (/room|joined|connected|waiting|host|guest|relay/i.test(t) && !/not connected|disconnect|lost/i.test(t)) {
        setConnectionVisual(/waiting/i.test(t) ? "waiting" : "online");
      } else if (/ready/i.test(t)) {
        setConnectionVisual("ready");
      } else if (/not connected|disconnect|error|enter a relay|room code/i.test(t)) {
        setConnectionVisual(/error|enter a relay|room code/i.test(t) ? "error" : "idle");
      }
      updatePartySlots();
    }

    function log(line) {
      el.log.textContent = (el.log.textContent + line + "\n").slice(-4000);
      el.log.scrollTop = el.log.scrollHeight;
    }

    let actionFlashTimer = null;

    function actionFlash(msg, kind) {
      if (!el.actionsHint) return;
      el.actionsHint.textContent = msg;
      if (el.banner) {
        el.banner.classList.remove("strame-web-hidden", "error", "win", "info");
        if (kind === "warn") el.banner.classList.add("error");
        else if (kind === "ok") el.banner.classList.add("info");
        el.banner.textContent = msg;
      }
      if (actionFlashTimer) clearTimeout(actionFlashTimer);
      actionFlashTimer = setTimeout(() => {
        if (el.banner && model.outcome === "ongoing") {
          el.banner.classList.add("strame-web-hidden");
          el.banner.classList.remove("error", "info");
        }
        refresh();
      }, kind === "ok" ? 1800 : 2600);
    }

    function guardTurn(showFeedback) {
      if (myTurn()) return true;
      if (showFeedback !== false) {
        actionFlash("Not your turn — wait for the opponent.", "warn");
      }
      return false;
    }

    function myTurn() {
      return seat !== null && model.current === seat && model.outcome === "ongoing";
    }

    function highlights() {
      const out = [];
      if (!myTurn()) return out;

      if (model.canStillRecruit()) {
        for (let r = 0; r < model.rows; r++) {
          const c = model.homeCol(seat);
          if (model.canRecruitAt(r, c)) out.push({ r, c, kind: "recruit" });
        }
      }

      if (model.uiMode === "recruit" || !model.selected) {
        return out;
      }
      if (model.uiMode === "move") {
        for (const t of model.legalMoveTargets(model.selected.r, model.selected.c)) {
          out.push({ r: t.r, c: t.c, kind: "move" });
        }
      } else if (model.uiMode === "attack") {
        for (const t of model.legalAttackTargets(model.selected.r, model.selected.c)) {
          out.push({ r: t.r, c: t.c, kind: "attack" });
        }
      }
      return out;
    }

    function refresh() {
      renderBoard(el.canvas, model, seat, highlights(), sprites);
      if (seat === null) return;

      const you = seat;
      const opp = seat === 0 ? 1 : 0;
      const youLabel = you === 0 ? "P1 · Blue · Host" : "P2 · Red · Guest";
      const oppLabel = opp === 0 ? "P1 · Blue · Host" : "P2 · Red · Guest";
      const youHome = you === 0 ? "Recruit on the left column" : "Recruit on the right column";
      const oppHome = opp === 0 ? "Left column" : "Right column";

      el.youRole.textContent = youLabel;
      el.youSide.textContent = youHome;
      el.yourGold.textContent = "Your gold: " + model.gold[you];
      el.oppRole.textContent = oppLabel;
      el.oppSide.textContent = oppHome;
      el.oppGold.textContent = "Opponent gold: " + model.gold[opp];

      const turnMine = myTurn();
      el.turnPill.textContent = turnMine
        ? "Your turn"
        : "Opponent's turn — " + (model.current === 0 ? "Blue (P1)" : "Red (P2)");
      el.turnPill.classList.toggle("is-yours", turnMine);
      el.turnPill.classList.toggle("is-waiting", !turnMine);

      if (turnMine) {
        if (model.uiMode === "recruit") {
          el.actionsHint.textContent =
            "Recruit mode: choose Soldier or Gollem, then click a green square in your home column.";
        } else if (model.uiMode === "move" && model.selected) {
          el.actionsHint.textContent = "Move mode: click a highlighted blue square.";
        } else if (model.uiMode === "attack" && model.selected) {
          el.actionsHint.textContent = "Attack mode: click a highlighted red square.";
        } else if (model.selected) {
          el.actionsHint.textContent =
            "Piece selected — choose Move, Attack, or Pass, or click End turn when finished.";
        } else if (model.canStillRecruit()) {
          el.actionsHint.textContent =
            "Your turn — click Recruit, then click a green square in your home column.";
        } else if (model.activationsPending() === 0) {
          el.actionsHint.textContent = "Your turn — click End turn when you are finished.";
        } else {
          el.actionsHint.textContent = "Your turn — select one of your pieces, or click End turn.";
        }
      } else {
        el.actionsHint.textContent = "Wait for your opponent. Controls unlock on your turn.";
      }

      el.actions.classList.toggle("is-active", turnMine);
      el.actions.classList.toggle("is-locked", !turnMine);
      el.actions.classList.toggle(
        "has-action-mode",
        turnMine && model.uiMode !== "idle"
      );

      if (el.recruitBtn) {
        const on = turnMine && model.uiMode === "recruit";
        el.recruitBtn.classList.toggle("active", on);
        el.recruitBtn.setAttribute("aria-pressed", on ? "true" : "false");
      }
      if (el.moveBtn) {
        const on = turnMine && model.uiMode === "move";
        el.moveBtn.classList.toggle("active", on);
        el.moveBtn.setAttribute("aria-pressed", on ? "true" : "false");
      }
      if (el.attackBtn) {
        const on = turnMine && model.uiMode === "attack";
        el.attackBtn.classList.toggle("active", on);
        el.attackBtn.setAttribute("aria-pressed", on ? "true" : "false");
      }
      if (el.passBtn) {
        el.passBtn.classList.remove("active");
        el.passBtn.setAttribute("aria-pressed", "false");
      }
      if (el.unit) {
        el.unit.disabled = !turnMine;
        el.unit.classList.toggle("is-recruit-picker", turnMine && model.uiMode === "recruit");
      }

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
        setStatus("Both players connected — starting match", "online");
        updatePartySlots();
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
        const parts = msg.split(/\s+/, 4);
        if (parts.length < 4 || seat === null) return;
        const actor = parts[2];
        const myActor = seat === 0 ? "P1" : "P2";
        if (actor === myActor) return;
        model.applyRemoteLine(parts[3]);
        log("← " + parts[3]);
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
      if (el.unit) model.recruitUnit = el.unit.value;
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
      setStatus(msg, "error");
    }

    async function connectOnline(asHost) {
      try {
        const url = el.relay.value.trim();
        if (!url) {
          throw new Error("Enter a relay URL in Connection settings");
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
        setLobbyConnecting(true);
        setStatus("Connecting to relay…", "connecting");
        online = new RelaySession(handleNetwork, onRelayFatal);
        await online.connect(url);
        if (asHost) {
          await online.host();
          seat = online.role === "host" ? 0 : 1;
          if (seat !== 0) throw new Error("Relay did not assign host role");
          el.code.value = online.roomCode;
          updateRoomCodeDisplay(online.roomCode);
          setLobbyMode("host");
          setStatus("Lobby open — share room code " + online.roomCode, "waiting");
        } else {
          const code = el.code.value.trim();
          if (!code) throw new Error("Enter a room code");
          await online.join(code);
          seat = online.role === "host" ? 0 : 1;
          if (seat !== 1) throw new Error("Relay did not assign guest role");
          updateRoomCodeDisplay(online.roomCode);
          setLobbyMode("join");
          setStatus("Joined " + online.roomCode + " — waiting for match", "waiting");
        }
        online.pump();
        startKeepalive();
        const name = el.name.value.trim();
        if (name) {
          online.send("PEERNAME " + btoa(unescape(encodeURIComponent(name))));
        }
        updatePartySlots();
      } catch (e) {
        stopKeepalive();
        showError(e.message || String(e));
        if (online) online.close();
        online = null;
        seat = null;
        updateRoomCodeDisplay("");
        updatePartySlots();
      } finally {
        setLobbyConnecting(false);
      }
    }

    function handleActionClick(ev) {
      const btn = ev.target.closest("button");
      if (!btn || !el.actions || !el.actions.contains(btn)) return;

      if (btn === el.recruitBtn) {
        if (!guardTurn()) return;
        if (!model.canStillRecruit()) {
          actionFlash(
            "Cannot recruit — you already placed a unit this turn or need more gold.",
            "warn"
          );
          return;
        }
        model.recruitUnit = el.unit ? el.unit.value : "S";
        model.uiMode = "recruit";
        model.clearPieceSelection();
        actionFlash(
          "Recruit mode ON — click a green square in your home column (or click one directly).",
          "ok"
        );
        refresh();
        return;
      }

      if (btn === el.moveBtn) {
        if (!guardTurn()) return;
        if (!model.selected) {
          actionFlash("Select one of your pieces on the board first.", "warn");
          return;
        }
        model.uiMode = "move";
        actionFlash("Move mode — click a highlighted blue square.", "ok");
        refresh();
        return;
      }

      if (btn === el.attackBtn) {
        if (!guardTurn()) return;
        if (!model.selected) {
          actionFlash("Select one of your pieces on the board first.", "warn");
          return;
        }
        model.uiMode = "attack";
        actionFlash("Attack mode — click a highlighted red square.", "ok");
        refresh();
        return;
      }

      if (btn === el.passBtn) {
        if (!guardTurn()) return;
        if (!model.selected) {
          actionFlash("Select one of your pieces on the board first.", "warn");
          return;
        }
        model.passSelected();
        actionFlash("Passed with selected piece.", "ok");
        refresh();
        return;
      }

      if (btn === el.endBtn) {
        if (!guardTurn()) return;
        if (!model.endTurnEarly()) {
          actionFlash("Recruit at least one piece before ending your turn.", "warn");
          return;
        }
        actionFlash("Turn ended — waiting for your opponent.", "ok");
        refresh();
      }
    }

    if (el.actions) {
      el.actions.addEventListener("click", handleActionClick);
    }

    root.querySelector("[data-host]").addEventListener("click", () => connectOnline(true));
    root.querySelector("[data-join]").addEventListener("click", () => connectOnline(false));

    if (el.tabHost) {
      el.tabHost.addEventListener("click", () => setLobbyMode("host"));
    }
    if (el.tabJoin) {
      el.tabJoin.addEventListener("click", () => setLobbyMode("join"));
    }
    if (el.name) {
      el.name.addEventListener("input", () => updatePartySlots());
    }
    if (el.copyCode) {
      el.copyCode.addEventListener("click", () => {
        const code = el.code.value.trim().toUpperCase();
        if (!code) return;
        const copied = () => {
          el.copyCode.textContent = "Copied!";
          setTimeout(() => {
            el.copyCode.textContent = "Copy";
          }, 1800);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(copied).catch(() => {
            el.code.select();
            document.execCommand("copy");
            copied();
          });
        } else {
          el.code.select();
          document.execCommand("copy");
          copied();
        }
      });
    }

    if (el.unit) {
      el.unit.addEventListener("change", () => {
        model.recruitUnit = el.unit.value;
      });
    }

    el.canvas.addEventListener("click", (ev) => {
      if (!guardTurn()) return;
      const rect = el.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const cellW = el.canvas.width / model.cols;
      const cellH = el.canvas.height / model.rows;
      const x = (ev.clientX - rect.left) * (el.canvas.width / rect.width);
      const y = (ev.clientY - rect.top) * (el.canvas.height / rect.height);
      const c = Math.floor(x / cellW);
      const r = Math.floor(y / cellH);
      if (r < 0 || c < 0 || r >= model.rows || c >= model.cols) return;

      if (model.uiMode === "recruit") {
        if (!model.canRecruitAt(r, c)) {
          const home = model.homeCol(seat) + 1;
          actionFlash(
            "Recruit only on empty green squares in your home column (column " + home + ").",
            "warn"
          );
          return;
        }
        const unitKey = el.unit ? el.unit.value : model.recruitUnit;
        if (model.recruit(unitKey, r, c)) {
          const unitName = UNITS[unitKey] ? UNITS[unitKey].name : unitKey;
          actionFlash(
            "Recruited " + unitName + " at row " + (r + 1) + ". Click End turn when you are done.",
            "ok"
          );
        }
        refresh();
        return;
      }
      if (model.canStillRecruit() && model.canRecruitAt(r, c)) {
        const unitKey = el.unit ? el.unit.value : model.recruitUnit;
        if (model.recruit(unitKey, r, c)) {
          const unitName = UNITS[unitKey] ? UNITS[unitKey].name : unitKey;
          actionFlash(
            "Recruited " + unitName + " at row " + (r + 1) + ". Click End turn when you are done.",
            "ok"
          );
        }
        refresh();
        return;
      }
      if (model.uiMode === "move" && model.selected) {
        const before = model.selected.r + "," + model.selected.c;
        model.moveTo(model.selected.r, model.selected.c, r, c);
        if (model.selected && model.selected.r + "," + model.selected.c !== before) {
          actionFlash("Moved piece.", "ok");
        }
        refresh();
        return;
      }
      if (model.uiMode === "attack" && model.selected) {
        model.attack(model.selected.r, model.selected.c, r, c);
        actionFlash("Attack resolved.", "ok");
        refresh();
        return;
      }
      model.select(r, c);
      if (model.selected) {
        actionFlash("Piece selected — choose Move, Attack, or Pass.", "ok");
      }
      refresh();
    });

    window.addEventListener("resize", () => refresh());
    refresh();
    setLobbyMode("host");
    updatePartySlots();
    setStatus("Ready — create or join a lobby", "ready");
  }

  global.StrameWeb = { mount, GameModel, MAPS, UNITS, WEB_CLIENT_VERSION };
})(typeof window !== "undefined" ? window : globalThis);
