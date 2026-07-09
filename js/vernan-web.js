(function (global) {
  "use strict";

  // --- constants.ts ---
/** Display & simulation constants from docs/game-specs.md */
const TILE_SIZE = 16;
const INTERNAL_WIDTH = 512;
const INTERNAL_HEIGHT = 320;
const CAMERA_ZOOM = 2;
const HUD_HEIGHT = 64;
const WORLD_VIEWPORT_W = INTERNAL_WIDTH / CAMERA_ZOOM;
const WORLD_VIEWPORT_H = INTERNAL_HEIGHT - HUD_HEIGHT;
const FIXED_STEP_HZ = 60;
const FIXED_DT = 1 / FIXED_STEP_HZ;
const WINDOW_SCALE = 2;
const DISPLAY_WIDTH = INTERNAL_WIDTH * WINDOW_SCALE;
const DISPLAY_HEIGHT = INTERNAL_HEIGHT * WINDOW_SCALE;
const CAMERA_EDGE_BUFFER_WORLD = 16 / CAMERA_ZOOM;
const PLAYER_STAND_H = 18;
const PLAYER_STAND_W = 10;
const SPRITE_FRAME_W = 32;
const SPRITE_FRAME_H = 32;

const TILE_EMPTY = 0;
const TILE_SOLID = 1;
const TILE_DOOR = 2;
const TILE_PLATFORM = 3;
const TILE_LADDER = 4;
const TILE_BREAKABLE = 5;
const TILE_KEYBLOCK = 6;
const TILE_KEYBLOCK_CONNECTOR = 7;

const WEB_CLIENT_VERSION_STR = "0.1.8";

  // --- math/util.ts ---

function rect(x, y, w, h){
  return { x, y, w, h };
}

function rectRight(r){
  return r.x + r.w;
}

function rectBottom(r){
  return r.y + r.h;
}

function rectsOverlap(a, b){
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

function clamp(v, lo, hi){
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a, b, t){
  return a + (b - a) * t;
}

/** Mulberry32 PRNG — deterministic from 32-bit seed */
function mulberry32(seed){
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashLayout(rooms){
  let h = 2166136261;
  const s = JSON.stringify(rooms);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

  // --- world/TileMap.ts ---


class TileMap {
  static fromAscii(rows){
    const h = rows.length;
    let w = 0;
    for (const r of rows) w = Math.max(w, r.length);
    const grid = [];
    for (let y = 0; y < h; y++) {
      const row = rows[y];
      grid[y] = [];
      for (let x = 0; x < w; x++) {
        const c = x < row.length ? row.charAt(x) : ".";
        grid[y][x] = charToTile(c);
      }
    }
    return new TileMap(grid);
  }

  static fromGrid(grid){
    return new TileMap(grid.map((r) => r.slice()));
  }

  constructor(grid) {
    this.height = grid.length;
    this.width = grid[0]?.length ?? 0;
    this.tiles = grid;
  }

  getWidth(){
    return this.width;
  }

  getHeight(){
    return this.height;
  }

  tileAt(tx, ty){
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return TILE_SOLID;
    return this.tiles[ty][tx];
  }

  setTile(tx, ty, id){
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return;
    this.tiles[ty][tx] = id;
  }

  isSolidTile(tx, ty){
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return true;
    const t = this.tiles[ty][tx];
    return (
      t === TILE_SOLID ||
      t === TILE_BREAKABLE ||
      t === TILE_KEYBLOCK ||
      t === TILE_KEYBLOCK_CONNECTOR
    );
  }

  isPlatformTile(tx, ty){
    return this.tileAt(tx, ty) === TILE_PLATFORM;
  }

  isLadderTile(tx, ty){
    return this.tileAt(tx, ty) === TILE_LADDER;
  }

  isDoorTile(tx, ty){
    return this.tileAt(tx, ty) === TILE_DOOR;
  }

  isBreakableTile(tx, ty){
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return false;
    return this.tiles[ty][tx] === TILE_BREAKABLE;
  }

  isStandableFloorTile(tx, ty){
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return false;
    const t = this.tiles[ty][tx];
    return t === TILE_SOLID || t === TILE_BREAKABLE || t === TILE_PLATFORM;
  }

  isSolidAtPixel(px, py){
    return this.isSolidTile(Math.floor(px / TILE_SIZE), Math.floor(py / TILE_SIZE));
  }

  groundTopWorldYAtColumn(tx){
    if (tx < 0 || tx >= this.width) return 0;
    let groundTop = (this.height - 2) * TILE_SIZE;
    let found = false;
    for (let ty = 1; ty < this.height - 2; ty++) {
      const t = this.tileAt(tx, ty);
      if (t === TILE_SOLID || t === TILE_BREAKABLE) continue;
      if (this.isStandableFloorTile(tx, ty + 1)) {
        groundTop = (ty + 1) * TILE_SIZE;
        found = true;
      }
    }
    if (found) return groundTop;
    for (let ty = this.height - 2; ty >= 1; ty--) {
      if (this.isStandableFloorTile(tx, ty)) return ty * TILE_SIZE;
    }
    return Math.max(1, this.height - 2) * TILE_SIZE;
  }

  copy(){
    return TileMap.fromGrid(this.tiles);
  }
}

function charToTile(c){
  switch (c) {
    case "#":
      return TILE_SOLID;
    case "D":
      return TILE_DOOR;
    case "-":
      return TILE_PLATFORM;
    case "H":
      return TILE_LADDER;
    case "B":
      return TILE_BREAKABLE;
    case "K":
      return TILE_KEYBLOCK;
    case "k":
      return TILE_KEYBLOCK_CONNECTOR;
    default:
      return TILE_EMPTY;
  }
}

function tileToColor(tile){
  switch (tile) {
    case TILE_SOLID:
      return "#4a6741";
    case TILE_PLATFORM:
      return "#6b8f5e";
    case TILE_LADDER:
      return "#8b6914";
    case TILE_DOOR:
      return "#5c4033";
    case TILE_BREAKABLE:
      return "#8b5a2b";
    case TILE_KEYBLOCK:
    case TILE_KEYBLOCK_CONNECTOR:
      return "#553355";
    default:
      return "#1a1a2e";
  }
}

  // --- world/DungeonLayout.ts ---


const RoomKind = {
  START: "START",
  NORMAL: "NORMAL",
  ITEM: "ITEM",
  SHOP: "SHOP",
  BOSS: "BOSS",
  SECRET: "SECRET",
  SUPER_SECRET: "SUPER_SECRET"
};


class DungeonLayout {
  constructor(rooms, cellToId) {
    this.rooms = rooms;
    this.cellToId = cellToId;
  }

  roomCount(){
    return this.rooms.length;
  }

  room(id){
    return this.rooms[id];
  }

  roomIdAt(gx, gy){
    return this.cellToId.get(key(gx, gy)) ?? -1;
  }

  neighborWest(id){
    const r = this.rooms[id];
    return this.roomIdAt(r.gridX - 1, r.gridY);
  }

  neighborEast(id){
    const r = this.rooms[id];
    return this.roomIdAt(r.gridX + 1, r.gridY);
  }

  neighborNorth(id){
    const r = this.rooms[id];
    return this.roomIdAt(r.gridX, r.gridY - 1);
  }

  neighborSouth(id){
    const r = this.rooms[id];
    return this.roomIdAt(r.gridX, r.gridY + 1);
  }

  allRooms(){
    return [...this.rooms];
  }

  static singleSandboxRoom(contentSeed){
    const node = {
      id: 0,
      gridX: 0,
      gridY: 0,
      contentSeed,
      doorWest: false,
      doorEast: false,
      ladderNorth: false,
      ladderSouth: false,
      ladderColumnTx: -1,
      kind: RoomKind.NORMAL,
    };
    const cell = new Map([[key(0, 0), 0]]);
    return new DungeonLayout([node], cell);
  }

  static generate(runSeed, targetRooms = 12, roomWidthTiles = 24){
    const n = Math.max(6, Math.min(24, targetRooms));
    const w = Math.max(24, roomWidthTiles);
    const rng = mulberry32(Number(runSeed & 0xffffffff));

    const cells = [{ gx: 0, gy: 0 }];
    const cellSet = new Set([key(0, 0)]);

    while (cells.length < n) {
      const pick = Math.floor(rng() * cells.length);
      const base = cells[pick];
      const dirs = [
        { gx: base.gx - 1, gy: base.gy },
        { gx: base.gx + 1, gy: base.gy },
        { gx: base.gx, gy: base.gy - 1 },
        { gx: base.gx, gy: base.gy + 1 },
      ];
      const d = dirs[Math.floor(rng() * dirs.length)];
      const k = key(d.gx, d.gy);
      if (!cellSet.has(k)) {
        cellSet.add(k);
        cells.push(d);
      }
    }

    const cellToId = new Map();
    const rooms = cells.map((c, id) => {
      cellToId.set(key(c.gx, c.gy), id);
      const contentSeed = (runSeed ^ (id * 0x9e3779b9)) >>> 0;
      return {
        id,
        gridX: c.gx,
        gridY: c.gy,
        contentSeed,
        doorWest: false,
        doorEast: false,
        ladderNorth: false,
        ladderSouth: false,
        ladderColumnTx: 3 + Math.floor(rng() * Math.max(1, w - 7)),
        kind: id === 0 ? RoomKind.START : RoomKind.NORMAL,
      };
    });

    for (const r of rooms) {
      r.doorWest = cellToId.has(key(r.gridX - 1, r.gridY));
      r.doorEast = cellToId.has(key(r.gridX + 1, r.gridY));
      r.ladderNorth = cellToId.has(key(r.gridX, r.gridY - 1));
      r.ladderSouth = cellToId.has(key(r.gridX, r.gridY + 1));
    }

    // Assign special rooms
    const specials = [RoomKind.ITEM, RoomKind.SHOP, RoomKind.BOSS];
    const candidates = rooms.filter((r) => r.id !== 0 && r.kind === RoomKind.NORMAL);
    for (const kind of specials) {
      if (candidates.length === 0) break;
      const idx = Math.floor(rng() * candidates.length);
      candidates[idx].kind = kind;
      candidates.splice(idx, 1);
    }

    return new DungeonLayout(rooms, cellToId);
  }
}

function key(gx, gy){
  return `${gx},${gy}`;
}

function layoutHash(layout){
  const data = layout.allRooms().map((r) => ({
    gx: r.gridX,
    gy: r.gridY,
    k: r.kind,
    w: r.doorWest,
    e: r.doorEast,
    n: r.ladderNorth,
    s: r.ladderSouth,
  }));
  let h = 2166136261;
  const s = JSON.stringify(data);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

  // --- world/RoomGenerator.ts ---





const WIDE_W = Math.max(64, WORLD_VIEWPORT_W / TILE_SIZE);
const WIDE_H = Math.max(12, WORLD_VIEWPORT_H / TILE_SIZE);
const SCREEN_W = Math.max(10, Math.ceil(WORLD_VIEWPORT_W / TILE_SIZE));
const SCREEN_H = Math.max(8, Math.ceil(WORLD_VIEWPORT_H / TILE_SIZE));

function isOneScreenRoomKind(k){
  return k !== RoomKind.NORMAL && k !== RoomKind.SECRET;
}

/** Procedural room generator (simplified port of RoomGenerator). */
function generateRoom(node){
  const oneScreen = isOneScreenRoomKind(node.kind);
  const w = oneScreen ? SCREEN_W : WIDE_W;
  const h = oneScreen ? SCREEN_H : WIDE_H;
  const rng = mulberry32(node.contentSeed >>> 0);

  const rows = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) {
      const border = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      if (border) row += "#";
      else if (y === h - 2) row += "#";
      else row += ".";
    }
    rows.push(row);
  }

  // Floor variation
  const gy = h - 2;
  for (let x = 1; x < w - 1; x++) {
    if (rng() < 0.08 && x > 3 && x < w - 4) {
      rows[gy] = setChar(rows[gy], x, "-");
    }
  }

  // Platforms
  const platCount = oneScreen ? 1 + Math.floor(rng() * 2) : 2 + Math.floor(rng() * 4);
  for (let i = 0; i < platCount; i++) {
    const px = 2 + Math.floor(rng() * (w - 6));
    const py = 4 + Math.floor(rng() * (h - 8));
    const len = 2 + Math.floor(rng() * 4);
    for (let dx = 0; dx < len && px + dx < w - 1; dx++) {
      rows[py] = setChar(rows[py], px + dx, "-");
    }
  }

  // Ladder shaft
  if (node.ladderNorth || node.ladderSouth) {
    const lx = Math.max(2, Math.min(w - 3, node.ladderColumnTx));
    const y0 = node.ladderNorth ? 1 : Math.floor(h / 2);
    const y1 = node.ladderSouth ? h - 3 : Math.floor(h / 2);
    for (let ly = y0; ly <= y1; ly++) {
      rows[ly] = setChar(rows[ly], lx, "H");
    }
  }

  // Doors
  if (node.doorWest) {
    rows[gy] = setChar(rows[gy], 1, "D");
    rows[gy - 1] = setChar(rows[gy - 1], 1, "D");
  }
  if (node.doorEast) {
    rows[gy] = setChar(rows[gy], w - 2, "D");
    rows[gy - 1] = setChar(rows[gy - 1], w - 2, "D");
  }

  // Boss room marker — solid pillars
  if (node.kind === RoomKind.BOSS) {
    for (let x = 4; x < w - 4; x += 5) {
      rows[gy - 3] = setChar(rows[gy - 3], x, "#");
    }
  }

  return TileMap.fromAscii(rows);
}

function setChar(row, x, c){
  return row.substring(0, x) + c + row.substring(x + 1);
}

function roomSpawnTx(node, map, fromWest, fromEast){
  if (fromWest && node.doorWest) return 2;
  if (fromEast && node.doorEast) return map.getWidth() - 3;
  return Math.floor(map.getWidth() / 2);
}

function tileKindLabel(kind){
  return kind;
}

  // --- combat/Health.ts ---
/** HP pool (simplified port of game.combat.Health). */
class Health {
  soul = 0;
  invulnRemaining = 0;

  constructor(redMax, fractional = false) {
    this.redMax = Math.max(0.001, redMax);
    this.redCurrent = fractional ? redMax : Math.max(1, redMax);
  }

  getCurrent(){
    return Math.floor(this.redCurrent + this.soul + 1e-9);
  }

  getMax(){
    return Math.floor(this.redMax + this.soul + 1e-9);
  }

  isAlive(){
    return this.redCurrent + this.soul > 1e-9;
  }

  isInvulnerable(){
    return this.invulnRemaining > 0;
  }

  tickInvuln(dt){
    if (this.invulnRemaining > 0) this.invulnRemaining = Math.max(0, this.invulnRemaining - dt);
  }

  tryDamage(amount, iFrames = 0){
    if (!this.isAlive() || this.isInvulnerable() || amount <= 0) return false;
    let remaining = amount;
    if (this.soul > 0) {
      const take = Math.min(this.soul, remaining);
      this.soul -= take;
      remaining -= take;
    }
    if (remaining > 0) {
      this.redCurrent = Math.max(0, this.redCurrent - remaining);
    }
    if (iFrames > 0) this.invulnRemaining = iFrames;
    return true;
  }

  heal(amount){
    this.redCurrent = Math.min(this.redMax, this.redCurrent + amount);
  }

  addSoul(amount){
    this.soul += amount;
  }
}

  // --- config/Physics.ts ---





const GRAVITY = 300;

function moveAndCollide(
  map,
  x,
  y,
  w,
  h,
  vx,
  vy,
  dt,
  onPlatform = false
){
  let nx = x + vx * dt;
  let ny = y + vy * dt;
  let nvx = vx;
  let nvy = vy;
  let grounded = false;

  // Horizontal
  if (vx !== 0) {
    const test = rect(nx, y, w, h);
    if (!overlapsSolids(map, test, onPlatform)) {
      x = nx;
    } else {
      const step = vx > 0 ? 1 : -1;
      while (Math.abs(nx - x) > 0.01) {
        const tryX = x + step;
        if (!overlapsSolids(map, rect(tryX, y, w, h), onPlatform)) x = tryX;
        else break;
      }
      nvx = 0;
    }
  }

  // Vertical
  if (vy !== 0) {
    const test = rect(x, ny, w, h);
    if (!overlapsSolids(map, test, onPlatform, vy > 0)) {
      y = ny;
    } else {
      const step = vy > 0 ? 1 : -1;
      while (Math.abs(ny - y) > 0.01) {
        const tryY = y + step;
        if (!overlapsSolids(map, rect(x, tryY, w, h), onPlatform, vy > 0)) y = tryY;
        else break;
      }
      if (vy > 0) {
        grounded = true;
        nvy = 0;
      } else {
        nvy = 0;
      }
    }
  }

  if (!grounded && nvy <= 0 && vy >= 0) {
    grounded = probeGrounded(map, x, y, w, h, onPlatform);
  }

  return { x, y, vx: nvx, vy: nvy, onGround: grounded };
}

function probeGrounded(map, x, y, w, h, onPlatform = false){
  const feet = y + h;
  return overlapsSolids(map, rect(x, feet, w, 2), onPlatform, true);
}

function overlapsSolids(
  map,
  r,
  allowPlatform,
  falling = false
){
  const x0 = Math.floor(r.x / TILE_SIZE);
  const x1 = Math.floor((r.x + r.w - 1e-6) / TILE_SIZE);
  const y0 = Math.floor(r.y / TILE_SIZE);
  const y1 = Math.floor((r.y + r.h - 1e-6) / TILE_SIZE);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (map.isSolidTile(tx, ty)) return true;
      if (map.isPlatformTile(tx, ty)) {
        if (!allowPlatform && falling) {
          const platTop = ty * TILE_SIZE;
          const feet = rectBottom(r);
          if (feet <= platTop + 2) return true;
        }
      }
    }
  }
  return false;
}

function defaultPlayerRect(x, y){
  return rect(x, y, PLAYER_STAND_W, PLAYER_STAND_H);
}

function spawnAtFloor(map, spawnTx){
  const groundTop = map.groundTopWorldYAtColumn(spawnTx);
  return { x: spawnTx * TILE_SIZE, y: groundTop - PLAYER_STAND_H };
}

  // --- input/Input.ts ---
/** Keyboard input with edge detection (ported from game.input.Input). */
const GAME_KEY_CODES = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "KeyA", "KeyD", "KeyW", "KeyS", "KeyZ", "KeyX", "KeyC", "Space",
]);

class Input {
  down = new Set();
  pressedThisFrame = new Set();
  releasedThisFrame = new Set();
  lagStashedPresses = new Set();

  bind(root) {
    const onDown = (e) => {
      if (GAME_KEY_CODES.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      const code = e.code;
      if (!this.down.has(code)) this.pressedThisFrame.add(code);
      this.down.add(code);
    };
    const onUp = (e) => {
      const code = e.code;
      this.down.delete(code);
      this.releasedThisFrame.add(code);
    };
    const onBlur = () => this.clearHardwareState();

    root.addEventListener("keydown", onDown);
    root.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      root.removeEventListener("keydown", onDown);
      root.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }

  isDown(code){
    return this.down.has(code);
  }

  wasPressed(code){
    return this.pressedThisFrame.has(code) || this.lagStashedPresses.has(code);
  }

  wasReleased(code){
    return this.releasedThisFrame.has(code);
  }

  consumePress(code){
    this.pressedThisFrame.delete(code);
    this.lagStashedPresses.delete(code);
  }

  /** Touch / virtual pad: hold */
  setDown(code, down){
    if (down) this.down.add(code);
    else this.down.delete(code);
  }

  /** Touch / virtual pad: tap edge */
  injectPress(code){
    if (!this.down.has(code)) this.pressedThisFrame.add(code);
    this.down.add(code);
  }

  endFrame(){
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.lagStashedPresses.clear();
  }

  stashPressEdgesForSkippedSim(){
    for (const c of this.pressedThisFrame) this.lagStashedPresses.add(c);
  }

  clearHardwareState(){
    this.down.clear();
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.lagStashedPresses.clear();
  }

  clearHardwareStateForRoomTransition(){
    this.endFrame();
  }
}

/** Key bindings from README / PlayerControls */
const Keys = {
  left: ["ArrowLeft", "KeyA"],
  right: ["ArrowRight", "KeyD"],
  up: ["ArrowUp", "KeyW"],
  down: ["ArrowDown", "KeyS"],
  jump: ["KeyZ", "Space"],
  attack: ["KeyX"],
  subweapon: ["KeyC"],
  debug: ["F3", "Backquote"],
};

function anyDown(input, codes){
  for (const c of codes) if (input.isDown(c)) return true;
  return false;
}

function anyPressed(input, codes){
  for (const c of codes) if (input.wasPressed(c)) return true;
  return false;
}

  // --- entity/Player.ts ---







class Player {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  facing = 1;
  onGround = false;
  wasOnGround = false;
  climbing = false;
  crouching = false;
  jumpSquatFrames = 0;
  coyoteTimer = 0;
  jumpBufferTimer = 0;
  attackPhase = 0;
  attackTimer = 0;
  animFrame = 0;
  animAccum = 0;
  hurtTint = 0;
  health = new Health(6);
  stats = {
    maxGroundSpeed: 85,
    maxAirSpeed: 70,
    climbSpeed: 80,
    groundAccel: 300,
    groundBrake: 500,
    groundFriction: 1800,
    airAccel: 150,
    airBrake: 1200,
    jumpVel: 140,
    jumpSquatFrames: 5,
    attackWindupFrames: 10,
    attackActiveFrames: 4,
    attackRecoverEarlyFrames: 12,
    attackRecoverLateFrames: 8,
    attackDamage: 1,
    keys: 0,
    money: 0,
  };

  prevX = 0;
  prevY = 0;

  resetAt(x, y){
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.prevX = x;
    this.prevY = y;
    this.onGround = false;
    this.wasOnGround = false;
    this.climbing = false;
    this.jumpSquatFrames = 0;
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this.attackPhase = 0;
    this.attackTimer = 0;
    this.hurtTint = 0;
  }

  w(){
    return PLAYER_STAND_W;
  }

  h(){
    return PLAYER_STAND_H;
  }

  anchorX(){
    return this.x;
  }

  anchorY(){
    return this.y + this.h() / 2;
  }

  feetY(){
    return this.y + this.h();
  }

  update(dt, input, map){
    this.prevX = this.x;
    this.prevY = this.y;
    this.wasOnGround = this.onGround;
    this.health.tickInvuln(dt);
    if (this.hurtTint > 0) this.hurtTint = Math.max(0, this.hurtTint - dt);

    const left = anyDown(input, Keys.left);
    const right = anyDown(input, Keys.right);
    const up = anyDown(input, Keys.up);
    const down = anyDown(input, Keys.down);
    this.crouching = down && this.onGround && !this.climbing;
    const jumpEdge = anyPressed(input, Keys.jump);
    const jumpHeld = anyDown(input, Keys.jump);
    const attackPressed = anyPressed(input, Keys.attack);

    // Attack state machine (phase 1 windup, 2 active, 3 early recover, 4 late recover)
    if (this.attackPhase > 0) {
      this.attackTimer -= dt;
      const frameSec = 1 / FIXED_STEP_HZ;
      if (this.attackTimer <= 0) {
        this.attackPhase++;
        if (this.attackPhase === 2) this.attackTimer = this.stats.attackActiveFrames * frameSec;
        else if (this.attackPhase === 3) this.attackTimer = this.stats.attackRecoverEarlyFrames * frameSec;
        else if (this.attackPhase === 4) this.attackTimer = this.stats.attackRecoverLateFrames * frameSec;
        else {
          this.attackPhase = 0;
          this.attackTimer = 0;
        }
      }
    } else if (attackPressed && !this.climbing) {
      this.attackPhase = 1;
      this.attackTimer = this.stats.attackWindupFrames / FIXED_STEP_HZ;
    }

    const blocksJump = this.attackPhase > 0 && this.attackPhase < 4;
    const inAttack = this.attackPhase > 0;

    // Ladder
    const tx = Math.floor((this.x + this.w() / 2) / TILE_SIZE);
    const onLadder = map.isLadderTile(tx, Math.floor(this.feetY() / TILE_SIZE)) ||
      map.isLadderTile(tx, Math.floor((this.y + 2) / TILE_SIZE));

    if (onLadder && (up || down)) {
      this.climbing = true;
      this.onGround = false;
      this.vx = 0;
      this.vy = 0;
      if (up) this.y -= this.stats.climbSpeed * dt;
      if (down) this.y += this.stats.climbSpeed * dt;
      if (left) this.facing = -1;
      if (right) this.facing = 1;
      this.animAccum += dt;
      if (this.animAccum > 0.12) {
        this.animAccum = 0;
        this.animFrame = (this.animFrame + 1) % 2;
      }
      return;
    }
    this.climbing = false;

    // Horizontal movement
    let targetVx = 0;
    if (!inAttack || this.attackPhase >= 3) {
      if (left) {
        this.facing = -1;
        targetVx = -this.stats.maxGroundSpeed;
      } else if (right) {
        this.facing = 1;
        targetVx = this.stats.maxGroundSpeed;
      }
    } else if (left) {
      this.facing = -1;
    } else if (right) {
      this.facing = 1;
    }

    const maxSpd = this.onGround ? this.stats.maxGroundSpeed : this.stats.maxAirSpeed;
    const accel = this.onGround ? this.stats.groundAccel : this.stats.airAccel;
    const brake = this.onGround ? this.stats.groundBrake : this.stats.airBrake;

    if (targetVx !== 0) {
      if (Math.sign(targetVx) !== Math.sign(this.vx) && this.vx !== 0) {
        this.vx = moveToward(this.vx, 0, brake * dt);
      }
      this.vx = moveToward(this.vx, targetVx, accel * dt);
    } else if (this.onGround) {
      this.vx = moveToward(this.vx, 0, this.stats.groundFriction * dt);
    } else {
      this.vx = moveToward(this.vx, 0, brake * dt);
    }
    this.vx = clamp(this.vx, -maxSpd, maxSpd);

    if (this.onGround) {
      this.coyoteTimer = 6 / FIXED_STEP_HZ;
    } else {
      this.coyoteTimer = Math.max(0, this.coyoteTimer - dt);
    }
    if (jumpEdge) {
      this.jumpBufferTimer = 8 / FIXED_STEP_HZ;
    } else {
      this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dt);
    }

    const canJump = this.onGround || this.coyoteTimer > 0;
    const wantsJump = jumpHeld || this.jumpBufferTimer > 0;

    // Jump squat
    if (!blocksJump && wantsJump && canJump && this.jumpSquatFrames === 0) {
      this.jumpSquatFrames = this.stats.jumpSquatFrames;
      this.jumpBufferTimer = 0;
      this.coyoteTimer = 0;
    }
    if (this.jumpSquatFrames > 0) {
      this.vy = 0;
      this.jumpSquatFrames--;
      if (this.jumpSquatFrames === 0) {
        this.vy = -this.stats.jumpVel;
        this.onGround = false;
      }
    }

    // Gravity
    if (!this.onGround) {
      this.vy = Math.min(this.vy + GRAVITY * dt, 3000);
    }

    const result = moveAndCollide(map, this.x, this.y, this.w(), this.h(), this.vx, this.vy, dt);
    this.x = result.x;
    this.y = result.y;
    this.vx = result.vx;
    this.vy = result.vy;
    if (this.vy < -1) {
      this.onGround = false;
    } else {
      this.onGround = result.onGround;
    }

    // Walk anim
    if (this.onGround && Math.abs(this.vx) > 5) {
      this.animAccum += dt;
      if (this.animAccum > 0.1) {
        this.animAccum = 0;
        this.animFrame = (this.animFrame + 1) % 4;
      }
    } else if (this.onGround) {
      this.animFrame = 0;
    } else {
      this.animFrame = this.vy < -20 ? 0 : 1;
    }
  }

  isAttackActive(){
    return this.attackPhase === 2 || this.attackPhase === 3;
  }

  attackHitbox(){
    if (!this.isAttackActive()) return null;
    const reach = 18;
    if (this.facing > 0) {
      return { x: this.x + this.w(), y: this.y + 2, w: reach, h: this.h() - 4 };
    }
    return { x: this.x - reach, y: this.y + 2, w: reach, h: this.h() - 4 };
  }

  isGroundedForSprite(){
    return this.onGround || (this.wasOnGround && this.vy >= -2);
  }

  spriteName(){
    if (this.attackPhase > 0) {
      return this.isGroundedForSprite() ? "vernan attack.png" : "vernan air attack.png";
    }
    if (this.climbing) return "vernan climb.png";
    if (!this.isGroundedForSprite()) return "vernan jump.png";
    if (this.crouching) return "vernan crouch.png";
    if (Math.abs(this.vx) > 5) return "vernan walk.png";
    return "vernan idle.png";
  }

  spriteFrameIndex(){
    const name = this.spriteName();
    if (name.includes("attack")) {
      if (this.attackPhase <= 1) return 0;
      if (this.attackPhase === 2) return 1;
      if (this.attackPhase === 3) return 2;
      return 3;
    }
    if (name.includes("walk")) return this.animFrame;
    if (name.includes("jump") || name.includes("climb")) return this.animFrame % 2;
    return 0;
  }
}

function moveToward(current, target, maxDelta){
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
}

  // --- entity/CrawlerEnemy.ts ---







const HOP_VX = 42;
const HOP_VY = -165;
const WALK_SPEED = 28;

class CrawlerEnemy {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  dir = 1;
  onGround = false;
  hopCooldown = 0.5;
  hurtTint = 0;
  health = new Health(2, true);
  animFrame = 0;
  animAccum = 0;
  dead = false;

  constructor(x, y) {
    this.x = x;
    this.y = y;
  }

  w = 8;
  h = 12;

  update(dt, map, player){
    if (this.dead || !this.health.isAlive()) {
      this.dead = true;
      return;
    }
    this.health.tickInvuln(dt);
    if (this.hurtTint > 0) this.hurtTint = Math.max(0, this.hurtTint - dt);

    this.hopCooldown -= dt;
    const dx = player.x - this.x;
    if (Math.abs(dx) > 4) this.dir = dx > 0 ? 1 : -1;

    if (this.onGround && this.hopCooldown <= 0) {
      this.vx = this.dir * HOP_VX;
      this.vy = HOP_VY;
      this.onGround = false;
      this.hopCooldown = 2.2 + Math.random() * 2;
    } else if (this.onGround) {
      this.vx = moveToward(this.vx, this.dir * WALK_SPEED, 200 * dt);
    }

    if (!this.onGround) {
      this.vy = Math.min(this.vy + GRAVITY * dt, 6000);
    }

    const r = moveAndCollide(map, this.x, this.y, this.w, this.h, this.vx, this.vy, dt);
    this.x = r.x;
    this.y = r.y;
    this.vx = r.vx;
    this.vy = r.vy;
    this.onGround = r.onGround;

    this.animAccum += dt;
    if (this.animAccum > 0.15) {
      this.animAccum = 0;
      this.animFrame = (this.animFrame + 1) % 2;
    }
  }

  takeHit(damage){
    if (this.health.tryDamage(damage, 0.35)) {
      this.hurtTint = 0.35;
      this.vx = -this.dir * 74;
      this.vy = -98;
      this.onGround = false;
      if (!this.health.isAlive()) this.dead = true;
    }
  }

  contactDamage(player){
    const pad = 2;
    const pr = { x: player.x - pad, y: player.y - pad, w: player.w() + pad * 2, h: player.h() + pad * 2 };
    const er = { x: this.x - pad, y: this.y - pad, w: this.w + pad * 2, h: this.h + pad * 2 };
    if (rectsOverlap(pr, er)) {
      if (player.health.tryDamage(1, 1.125)) {
        player.hurtTint = 0.35;
      }
    }
  }

  hitbox() {
    return { x: this.x, y: this.y, w: this.w, h: this.h };
  }
}

function moveToward(c, t, d){
  if (Math.abs(t - c) <= d) return t;
  return c + Math.sign(t - c) * d;
}

function spawnEnemiesForRoom(map, seed, count = 2){
  const enemies = [];
  const gy = map.getHeight() - 2;
  for (let i = 0; i < count; i++) {
    const tx = 4 + ((seed + i * 7) % Math.max(1, map.getWidth() - 8));
    const groundY = map.groundTopWorldYAtColumn(tx);
    enemies.push(new CrawlerEnemy(tx * TILE_SIZE, groundY - 12));
  }
  return enemies;
}

  // --- camera/SideScrollCamera.ts ---


/** Side-scrolling camera (ported from game.camera.SideScrollCamera). */
class SideScrollCamera {
  centerX = 0;
  centerY = 0;
  landingEaseTimer = 0;
  smoothedIdealX = 0;
  ladderSmoothBias = 0;
  faceBiasActive = false;

  static H_DEAD_ZONE_FRAC = 0.2;
  static H_MAX_SPEED = 210;
  static H_FACE_BIAS = 22;
  static H_FACE_VX_BIAS_ON = 48;
  static H_FACE_VX_BIAS_OFF = 28;
  static H_IDEAL_SMOOTH_TAU = 0.11;
  static V_DEAD_ZONE_FRAC = 0.14;
  static V_SPEED_GROUND = 190;
  static V_SPEED_AIR_UP = 250;
  static V_SPEED_AIR_DOWN = 105;
  static V_LANDING_BOOST_TIME = 0.14;
  static V_LANDING_SPEED_MULT = 2.15;

  reset(anchorX, anchorY){
    this.centerX = anchorX;
    this.centerY = anchorY;
    this.smoothedIdealX = anchorX;
    this.landingEaseTimer = 0;
    this.ladderSmoothBias = 0;
    this.faceBiasActive = false;
  }

  update(
    dt,
    bounds,
    input
  ){
    const justLanded = !input.wasOnGround && input.onGround;
    if (justLanded) this.landingEaseTimer = SideScrollCamera.V_LANDING_BOOST_TIME;
    else this.landingEaseTimer = Math.max(0, this.landingEaseTimer - dt);

    if (!(input.climbing && input.ladderColumnValid)) this.ladderSmoothBias = 0;

    const avx = Math.abs(input.vx);
    if (this.faceBiasActive) {
      if (avx <= SideScrollCamera.H_FACE_VX_BIAS_OFF) this.faceBiasActive = false;
    } else if (avx >= SideScrollCamera.H_FACE_VX_BIAS_ON) {
      this.faceBiasActive = true;
    }

    let rawIdealX = input.anchorX;
    if (this.faceBiasActive) rawIdealX += input.facing * SideScrollCamera.H_FACE_BIAS;

    const alpha = 1 - Math.exp(-dt / Math.max(1e-4, SideScrollCamera.H_IDEAL_SMOOTH_TAU));
    this.smoothedIdealX += (rawIdealX - this.smoothedIdealX) * alpha;

    this.chaseHorizontal(bounds.halfViewW, this.smoothedIdealX, SideScrollCamera.H_DEAD_ZONE_FRAC, SideScrollCamera.H_MAX_SPEED, dt);

    if (input.climbing && input.ladderColumnValid) {
      this.ladderVertical(dt, bounds, input);
    } else {
      this.chaseVerticalNormal(dt, bounds, input);
    }

    this.centerX = clamp(this.centerX, bounds.minAnchorX, bounds.maxAnchorX);
    this.centerY = clamp(this.centerY, bounds.minAnchorY, bounds.maxAnchorY);
  }

  chaseHorizontal(
    halfViewW,
    idealX,
    deadFrac,
    maxSpeed,
    dt
  ){
    const dead = halfViewW * deadFrac;
    const diff = idealX - this.centerX;
    const step = maxSpeed * dt;
    if (diff > dead) this.centerX += Math.min(diff - dead, step);
    else if (diff < -dead) this.centerX -= Math.min(-diff - dead, step);
  }

  chaseVerticalNormal(dt, b, in_){
    const idealY = in_.anchorY;
    const dead = b.halfViewH * SideScrollCamera.V_DEAD_ZONE_FRAC;
    const diff = idealY - this.centerY;
    const vMult = this.landingEaseTimer > 0 ? SideScrollCamera.V_LANDING_SPEED_MULT : 1;
    let speed;
    if (!in_.onGround) speed = in_.vy < -30 ? SideScrollCamera.V_SPEED_AIR_UP : SideScrollCamera.V_SPEED_AIR_DOWN;
    else speed = SideScrollCamera.V_SPEED_GROUND;
    speed *= vMult;
    const step = speed * dt;
    if (diff > dead) this.centerY += Math.min(diff - dead, step);
    else if (diff < -dead) this.centerY -= Math.min(-diff - dead, step);
  }

  ladderVertical(dt, b, in_){
    const viewH = in_.viewWorldH;
    const hi = in_.ladderHighRow;
    const lo = in_.ladderLowRow;
    const ts = in_.tileSize;
    const shaftH = (lo - hi + 1) * ts;
    const coverage = clamp(shaftH / Math.max(1e-6, viewH), 0, 1);
    let lookFrac = lerp(0.12, 0.2, coverage);
    lookFrac = clamp(lookFrac, 0, 0.3);
    let manualBias = 0;
    if (in_.inputUp && !in_.inputDown) manualBias = -lookFrac * viewH;
    else if (in_.inputDown && !in_.inputUp) manualBias = lookFrac * viewH;
    const maxBias = 0.3 * viewH;
    const steering = in_.inputUp || in_.inputDown;
    const targetBias = steering ? manualBias : 0;
    const tau = steering ? 0.06 : 2.4;
    const beta = 1 - Math.exp(-dt / Math.max(1e-4, tau));
    this.ladderSmoothBias += (targetBias - this.ladderSmoothBias) * beta;
    this.ladderSmoothBias = clamp(this.ladderSmoothBias, -maxBias, maxBias);
    let idealY = in_.anchorY + this.ladderSmoothBias;
    const shaftTop = hi * ts;
    const shaftBot = (lo + 1) * ts;
    const halfH = b.halfViewH;
    const buf = b.edgeBufferWorld;
    let cyMinShaft = shaftTop + halfH - buf;
    let cyMaxShaft = shaftBot - halfH + buf;
    if (cyMinShaft > cyMaxShaft) {
      const mid = (shaftTop + shaftBot) * 0.5;
      cyMinShaft = mid;
      cyMaxShaft = mid;
    }
    idealY = clamp(idealY, cyMinShaft, cyMaxShaft);
    idealY = clamp(idealY, b.minAnchorY, b.maxAnchorY);
    const diff = idealY - this.centerY;
    const dead = b.halfViewH * 0.02;
    const step = 165 * dt;
    if (diff > dead) this.centerY += Math.min(diff - dead, step);
    else if (diff < -dead) this.centerY -= Math.min(-diff - dead, step);
  }
}



  // --- item/ItemCatalog.ts ---

class ItemCatalog {
  items = new Map();

  static async load(assetBase){
    const cat = new ItemCatalog();
    const res = await fetch(assetBase + "data/items.json");
    if (!res.ok) throw new Error("Failed to load items.json");
    const json = await res.json();
    for (const item of json.items) {
      cat.items.set(item.id, item);
    }
    return cat;
  }

  get(id){
    return this.items.get(id);
  }

  all(){
    return [...this.items.values()];
  }

  applyToPlayer(item, player){
    player.stats.attackDamage += item.damageBonusPerStack;
    player.stats.maxGroundSpeed += item.groundSpeedBonusPerStack;
    player.stats.maxAirSpeed += item.airSpeedBonusPerStack;
    player.stats.jumpSquatFrames = Math.max(1, player.stats.jumpSquatFrames + item.jumpSquatFramesBonusPerStack);
    if (item.redHeartsHealOnPickup > 0) player.health.heal(item.redHeartsHealOnPickup);
    if (item.soulHeartsOnPickup > 0) player.health.addSoul(item.soulHeartsOnPickup);
  }
}

  // --- assets/AssetLoader.ts ---
/** Sprite & JSON asset loader with progress tracking. */
class AssetLoader {
  images = new Map();
  loaded = 0;
  total = 0;

  constructor(assetBase) {
    this.assetBase = assetBase;
  }

  async loadCore(){
    const required = [
      "sprites/vernan idle.png",
      "sprites/vernan walk.png",
      "sprites/vernan crouch.png",
      "sprites/vernan jump.png",
      "sprites/vernan climb.png",
      "sprites/vernan attack.png",
      "sprites/vernan air attack.png",
      "sprites/crawler.png",
      "sprites/UI health.png",
    ];
    const optional = [
      "sprites/UI key.png",
      "sprites/UI coin.png",
      "tiles/forest tileset.png",
    ];
    this.total = required.length + optional.length;
    this.loaded = 0;
    await Promise.all(required.map((p) => this.loadImage(p)));
    await Promise.all(
      optional.map((p) =>
        this.loadImage(p).catch(() => {
          this.loaded++;
        })
      )
    );
  }

  async loadImage(relPath){
    const key = relPath;
    const existing = this.images.get(key);
    if (existing) return existing;

    const url = this.assetBase + relPath;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url}`);
    const blob = await res.blob();
    let img;
    if (typeof createImageBitmap === "function") {
      img = await createImageBitmap(blob);
    } else {
      img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = URL.createObjectURL(blob);
      });
    }
    this.images.set(key, img);
    this.loaded++;
    return img;
  }

  get(relPath){
    return this.images.get(relPath);
  }

  progress(){
    return this.total > 0 ? this.loaded / this.total : 1;
  }
}

  // --- runtime/GameSim.ts ---














class GameSim {
  player = new Player();
  camera = new SideScrollCamera();
  currentRoomId = 0;
  enemies = [];
  transitionFade = 0;
  transitionDir = null;
  debugOverlay = false;
  fps = 0;
  ups = 0;

  constructor(opts) {
    this.seed = opts.seed;
    this.layout = DungeonLayout.generate(opts.seed, 12, 24);
    const node = this.layout.room(0);
    this.map = generateRoom(node);
    this.enemies = spawnEnemiesForRoom(this.map, node.contentSeed, 2);
    const spawn = spawnAtFloor(this.map, roomSpawnTx(node, this.map, false, false));
    this.player.resetAt(spawn.x, spawn.y);
    this.camera.reset(this.cameraAnchorX(), this.cameraAnchorY());
  }

  getSeed(){
    return this.seed;
  }

  update(dt, input){
    if (this.transitionFade > 0) {
      this.transitionFade = Math.max(0, this.transitionFade - dt * 2);
      return;
    }

    this.player.update(dt, input, this.map);

    for (const e of this.enemies) {
      e.update(dt, this.map, this.player);
      e.contactDamage(this.player);
    }

    // Sword hits
    const hit = this.player.attackHitbox();
    if (hit) {
      for (const e of this.enemies) {
        if (e.dead) continue;
        const hb = e.hitbox();
        if (
          hit.x < hb.x + hb.w &&
          hit.x + hit.w > hb.x &&
          hit.y < hb.y + hb.h &&
          hit.y + hit.h > hb.y
        ) {
          e.takeHit(this.player.stats.attackDamage);
        }
      }
    }

    // Door transitions
    this.tryDoorTransition(input);

    const bounds = this.scrollBounds();
    const follow = {
      anchorX: this.cameraAnchorX(),
      anchorY: this.cameraAnchorY(),
      vx: this.player.vx,
      vy: this.player.vy,
      facing: this.player.facing,
      onGround: this.player.onGround,
      wasOnGround: this.player.wasOnGround,
      climbing: this.player.climbing,
      inputUp: false,
      inputDown: false,
      ladderColumnValid: false,
      ladderHighRow: 0,
      ladderLowRow: 0,
      viewWorldH: WORLD_VIEWPORT_H / CAMERA_ZOOM,
      tileSize: TILE_SIZE,
      focusMinX: 0,
      focusMaxX: 0,
      enemyFocusCount: this.enemies.filter((e) => !e.dead).length,
      ladderEnemyBelowExtraWorld: 0,
    };
    this.camera.update(dt, bounds, follow);
  }

  tryDoorTransition(input){
    const feetY = this.player.feetY();
    const tx = Math.floor((this.player.x + this.player.w() / 2) / TILE_SIZE);
    const ty = Math.floor(feetY / TILE_SIZE);
    const node = this.layout.room(this.currentRoomId);

    if (node.doorWest && tx <= 1 && this.player.x < TILE_SIZE * 2) {
      const west = this.layout.neighborWest(this.currentRoomId);
      if (west >= 0) this.beginTransition(west, "west");
    } else if (node.doorEast && tx >= this.map.getWidth() - 2) {
      const east = this.layout.neighborEast(this.currentRoomId);
      if (east >= 0) this.beginTransition(east, "east");
    }
  }

  beginTransition(roomId, dir) {
    this.currentRoomId = roomId;
    const node = this.layout.room(roomId);
    this.map = generateRoom(node);
    this.enemies = spawnEnemiesForRoom(
      this.map,
      node.contentSeed,
      node.kind === RoomKind.BOSS ? 0 : 2
    );
    const spawnTx = roomSpawnTx(node, this.map, dir === "west", dir === "east");
    const spawn = spawnAtFloor(this.map, spawnTx);
    this.player.resetAt(spawn.x, spawn.y);
    this.transitionFade = 1;
    this.transitionDir = dir;
  }

  scrollBounds(){
    const halfViewW = INTERNAL_WIDTH / (2 * CAMERA_ZOOM);
    const halfViewH = WORLD_VIEWPORT_H / (2 * CAMERA_ZOOM);
    const mapW = this.map.getWidth() * TILE_SIZE;
    const mapH = this.map.getHeight() * TILE_SIZE;
    const buf = CAMERA_EDGE_BUFFER_WORLD;
    let minAnchorX = halfViewW;
    let maxAnchorX = mapW - halfViewW;
    if (minAnchorX > maxAnchorX) {
      const cx = mapW * 0.5;
      minAnchorX = maxAnchorX = cx;
    }
    let minAnchorY = halfViewH;
    let maxAnchorY = mapH - halfViewH;
    if (minAnchorY > maxAnchorY) {
      const cy = mapH * 0.5;
      minAnchorY = maxAnchorY = cy;
    }
    return {
      halfViewW,
      halfViewH,
      minAnchorX: minAnchorX + buf,
      maxAnchorX: maxAnchorX >= minAnchorX ? maxAnchorX - buf : maxAnchorX,
      minAnchorY: minAnchorY + buf,
      maxAnchorY: maxAnchorY >= minAnchorY ? maxAnchorY - buf : maxAnchorY,
      edgeBufferWorld: buf,
    };
  }

  cameraAnchorY(){
    return this.player.feetY() - PLAYER_STAND_H * 0.5;
  }

  cameraAnchorX(){
    return this.player.x + this.player.w() * 0.5;
  }

  renderAlpha(alpha){
    return {
      playerX: lerp(this.player.prevX, this.player.x, alpha),
      playerY: lerp(this.player.prevY, this.player.y, alpha),
      cameraX: this.camera.centerX,
      cameraY: this.camera.centerY,
      facing: this.player.facing,
      spriteName: this.player.spriteName(),
      spriteFrame: this.player.spriteFrameIndex(),
      enemies: this.enemies.map((e) => ({
        x: e.x,
        y: e.y,
        dead: e.dead,
        hurtTint: e.hurtTint,
        animFrame: e.animFrame,
      })),
      transitionFade: this.transitionFade,
      debugOverlay: this.debugOverlay,
      playerHurtTint: this.player.hurtTint,
      hp: this.player.health.getCurrent(),
      hpMax: this.player.health.getMax(),
      keys: this.player.stats.keys,
      money: this.player.stats.money,
      roomKind: this.layout.room(this.currentRoomId).kind,
      seed: this.seed,
    };
  }
}


const DISPLAY = {
  internalWidth: INTERNAL_WIDTH,
  internalHeight: INTERNAL_HEIGHT,
  scale: 2,
};

  // --- runtime/GameLoop.ts ---



const TIMESTOP_ENTER_SEC = 0.05;
const TIMESTOP_EXIT_SEC = 0.022;

/** Fixed-timestep loop (ported from game.loop.GameLoop). */
class GameLoop {
  running = false;
  rafId = 0;
  last = 0;
  accumulator = 0;
  timestopActive = false;
  fpsTimer = 0;
  fps = 0;
  ups = 0;

  constructor(
    callbacks,
    targetUps = FIXED_STEP_HZ,
    maxSubstepsPerFrame = 30
  ) {
    this.callbacks = callbacks;
    this.targetUps = targetUps;
    this.maxSubstepsPerFrame = maxSubstepsPerFrame;
  }

  start(){
    if (this.running) return;
    this.running = true;
    this.last = performance.now() / 1000;
    this.fpsTimer = this.last;
    const tick = (nowMs) => {
      if (!this.running) return;
      const now = nowMs / 1000;
      let frameSeconds = now - this.last;
      this.last = now;
      if (frameSeconds > 0.25) frameSeconds = 0.25;

      if (frameSeconds > TIMESTOP_ENTER_SEC) this.timestopActive = true;
      else if (this.timestopActive && frameSeconds <= TIMESTOP_EXIT_SEC)
        this.timestopActive = false;

      const dt = 1 / Math.max(1, this.targetUps);
      if (!this.timestopActive) this.accumulator += frameSeconds;

      const maxAccum = dt * this.maxSubstepsPerFrame;
      if (this.accumulator > maxAccum) this.accumulator = maxAccum;

      let substeps = 0;
      if (!this.timestopActive) {
        while (this.accumulator >= dt && substeps < this.maxSubstepsPerFrame) {
          this.callbacks.update(dt);
          this.ups++;
          this.accumulator -= dt;
          substeps++;
        }
      }

      this.callbacks.endInputFrameAfterSimBatch?.(substeps > 0, this.timestopActive);

      let renderAlpha = this.timestopActive ? 0 : this.accumulator / dt;
      if (renderAlpha < 0) renderAlpha = 0;
      else if (renderAlpha > 1) renderAlpha = 1;

      this.callbacks.render(renderAlpha);
      this.fps++;

      if (now - this.fpsTimer >= 1) {
        this.callbacks.onFpsUpdate?.(this.fps, this.ups);
        this.fps = 0;
        this.ups = 0;
        this.fpsTimer = now;
      }

      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(){
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }
}

  // --- render/RenderPipeline.ts ---





class RenderPipeline {
  constructor(displayCanvas) {
    this.displayCanvas = displayCanvas;
    const c = document.createElement("canvas");
    c.width = INTERNAL_WIDTH;
    c.height = INTERNAL_HEIGHT;
    this.backbuffer = c;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
  }

  draw(sim, snap, assets){
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0d0d14";
    ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);

    const tx = Math.floor(INTERNAL_WIDTH / 2 - CAMERA_ZOOM * snap.cameraX);
    const ty = Math.floor(WORLD_VIEWPORT_H / 2 - CAMERA_ZOOM * snap.cameraY);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, INTERNAL_WIDTH, WORLD_VIEWPORT_H);
    ctx.clip();
    ctx.setTransform(CAMERA_ZOOM, 0, 0, CAMERA_ZOOM, tx, ty);

    this.drawTiles(ctx, sim, snap.cameraX, snap.cameraY, assets);
    this.drawEnemies(ctx, snap, assets);
    this.drawPlayer(ctx, snap, assets);

    if (snap.debugOverlay) {
      this.drawDebugGrid(ctx, sim);
    }

    ctx.restore();

    // HUD
    this.drawHud(ctx, snap, assets);

    // Fade
    if (snap.transitionFade > 0) {
      ctx.fillStyle = `rgba(0,0,0,${snap.transitionFade * 0.85})`;
      ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
    }

    // Blit to display
    const dctx = this.displayCanvas.getContext("2d");
    if (!dctx) return;
    dctx.imageSmoothingEnabled = false;
    dctx.clearRect(0, 0, this.displayCanvas.width, this.displayCanvas.height);
    dctx.drawImage(
      this.backbuffer,
      0,
      0,
      INTERNAL_WIDTH,
      INTERNAL_HEIGHT,
      0,
      0,
      this.displayCanvas.width,
      this.displayCanvas.height
    );
  }

  drawTiles(ctx, sim, camX, camY, assets){
    const map = sim.map;
    const tileset = assets.get("tiles/forest tileset.png");
    const viewWorldW = WORLD_VIEWPORT_W;
    const viewWorldH = WORLD_VIEWPORT_H / CAMERA_ZOOM;
    const viewLeft = camX - viewWorldW / 2;
    const viewTop = camY - viewWorldH / 2;
    const x0 = Math.max(0, Math.floor(viewLeft / TILE_SIZE) - 1);
    const y0 = Math.max(0, Math.floor(viewTop / TILE_SIZE) - 1);
    const x1 = Math.min(map.getWidth() - 1, Math.ceil((viewLeft + viewWorldW) / TILE_SIZE) + 1);
    const y1 = Math.min(map.getHeight() - 1, Math.ceil((viewTop + viewWorldH) / TILE_SIZE) + 1);

    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const t = map.tileAt(tx, ty);
        const px = tx * TILE_SIZE;
        const py = ty * TILE_SIZE;
        if (tileset && t === 1) {
          // Solid floor — row 7 of forest tileset
          ctx.drawImage(tileset, 0, 7 * 16, 16, 16, px, py, 16, 16);
        } else {
          ctx.fillStyle = tileToColor(t);
          ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        }
      }
    }
  }

  drawPlayer(ctx, snap, assets){
    const sheet = assets.get("sprites/" + snap.spriteName);
    const feetY = snap.playerY + 18;
    const drawX = snap.playerX + 5 - SPRITE_FRAME_W / 2;
    const drawY = feetY - SPRITE_FRAME_H;

    if (sheet) {
      const frame = snap.spriteFrame;
      const fw = SPRITE_FRAME_W;
      if (snap.playerHurtTint > 0) {
        ctx.globalAlpha = 0.65 + 0.35 * (snap.playerHurtTint / 0.35);
      }
      ctx.save();
      if (snap.facing < 0) {
        ctx.translate(drawX + fw, drawY);
        ctx.scale(-1, 1);
        ctx.drawImage(sheet, frame * fw, 0, fw, SPRITE_FRAME_H, 0, 0, fw, SPRITE_FRAME_H);
      } else {
        ctx.drawImage(sheet, frame * fw, 0, fw, SPRITE_FRAME_H, drawX, drawY, fw, SPRITE_FRAME_H);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = snap.playerHurtTint > 0 ? "#ffaaaa" : "#e8a87c";
      ctx.fillRect(snap.playerX, snap.playerY, 10, 18);
    }
  }

  drawEnemies(
    ctx,
    snap,
    assets
  ){
    const sheet = assets.get("sprites/crawler.png");
    for (const e of snap.enemies) {
      if (e.dead) continue;
      if (sheet) {
        ctx.drawImage(sheet, e.animFrame * 16, 0, 16, 16, e.x - 4, e.y, 16, 16);
      } else {
        ctx.fillStyle = e.hurtTint > 0 ? "#ff8888" : "#88ff88";
        ctx.fillRect(e.x, e.y, 8, 12);
      }
    }
  }

  drawHud(ctx, snap, assets){
    const hudY = INTERNAL_HEIGHT - HUD_HEIGHT;
    ctx.fillStyle = "#111118";
    ctx.fillRect(0, hudY, INTERNAL_WIDTH, HUD_HEIGHT);

    const heart = assets.get("sprites/UI health.png");
    for (let i = 0; i < snap.hpMax; i++) {
      const filled = i < snap.hp;
      if (heart) {
        ctx.drawImage(heart, filled ? 0 : 8, 0, 8, 8, 8 + i * 10, hudY + 8, 8, 8);
      } else {
        ctx.fillStyle = filled ? "#e74c3c" : "#333";
        ctx.fillRect(8 + i * 10, hudY + 8, 8, 8);
      }
    }

    ctx.fillStyle = "#aaa";
    ctx.font = "8px monospace";
    ctx.fillText(`Keys:${snap.keys} $:${snap.money}`, 8, hudY + 28);
    ctx.fillText(`${snap.roomKind} seed:${snap.seed}`, INTERNAL_WIDTH - 120, hudY + 28);
  }

  drawDebugGrid(ctx, sim){
    const map = sim.map;
    ctx.strokeStyle = "rgba(0,255,0,0.25)";
    for (let ty = 0; ty < map.getHeight(); ty++) {
      for (let tx = 0; tx < map.getWidth(); tx++) {
        ctx.strokeRect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }
  }
}

  // --- render/PostFx.ts ---
/** Pixel palette clamp (simplified GameColorPalette). */
function applyPaletteClamp(
  ctx,
  width,
  height
){
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = (d[i] >> 2) << 2;
    d[i + 1] = (d[i + 1] >> 2) << 2;
    d[i + 2] = (d[i + 2] >> 2) << 2;
  }
  ctx.putImageData(img, 0, 0);
}

/** Smoke heat distortion stub */
function applySmokeDistortion(_ctx){
  // Full pixel warp deferred; hook exists for parity
}

  // --- boss/BossRegistry.ts ---
const BossKind = {
  MODERN_CHICKEN: "MODERN_CHICKEN",
  POSSESSED: "POSSESSED",
  NEPHILIM: "NEPHILIM"
};


/** Boss registry (ported from game.boss.BossRegistry). */
class BossRegistry {
  static forRoomKind(kind){
    if (kind === "BOSS") return BossKind.MODERN_CHICKEN;
    return null;
  }

  static create(kind){
    const max = kind === BossKind.NEPHILIM ? 40 : kind === BossKind.POSSESSED ? 30 : 24;
    return { kind, health: max, maxHealth: max, phase: 0, active: true };
  }
}

/** Stub boss update — full AI ported in Phase 8 extension */
function updateBoss(boss, dt){
  if (!boss.active) return;
  // Phase placeholder: bosses use room-specific spawn in GameSim
  void dt;
}

  // --- vernan/VernanBodyCompositor.ts ---
/** Costume layer compositor (simplified port of VernanBodyCompositor). */

class VernanBodyCompositor {
  cache = new Map();

  async compose(
    basePath,
    layers,
    loader
  ){
    const key = basePath + "|" + layers.map((l) => l.imagePath).join(",");
    const cached = this.cache.get(key);
    if (cached) return cached;

    const base = await loader(basePath);
    const w = "width" in base ? base.width : 32;
    const h = "height" in base ? base.height : 32;
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d unavailable");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(base, 0, 0);
    for (const layer of layers) {
      const img = await loader(layer.imagePath);
      ctx.drawImage(img, 0, 0);
    }
    this.cache.set(key, canvas);
    return canvas;
  }
}

/** Anim cue squash/stretch from vernan_anim_cues.json */

function applyAnimCue(
  ctx,
  feetX,
  feetY,
  cue
){
  if (!cue || (cue.squashX === 1 && cue.squashY === 1)) return;
  ctx.translate(feetX, feetY);
  ctx.scale(cue.squashX, cue.squashY);
  ctx.translate(-feetX, -feetY);
}

  // --- tileset/TilesetRuntime.ts ---
/** Tileset v3 runtime loader (simplified — full autotile in tileset/TilesetRuntime.ts). */

async function loadTileset(assetBase){
  try {
    const res = await fetch(assetBase + "tileset/tileset.json");
    if (!res.ok) return null;
    return (await res.json());
  } catch {
    return null;
  }
}

/** Resolve autotile cell — stub delegates to colored fallback in RenderPipeline */
function resolveAutotileCell(_terrain, _neighbors){
  return 0;
}

  // --- sandbox/SandboxSession.ts ---
/** Sandbox mode stub (ported from game.sandbox.SandboxSession). */



class SandboxSession {
  world = TileMap.fromAscii([
    "##################",
    "#................#",
    "#................#",
    "#................#",
    "#................#",
    "##################",
  ]);
  paintMode = false;

  togglePaint(){
    this.paintMode = !this.paintMode;
  }

  paintSolid(tx, ty){
    if (!this.paintMode) return;
    this.world.setTile(tx, ty, 1);
  }

  toLayout(seed){
    return DungeonLayout.singleSandboxRoom(seed);
  }
}

  // --- index.ts ---












function parseSeed(options){
  if (options?.seed != null) return options.seed >>> 0;
  const q = new URLSearchParams(location.search).get("seed");
  if (q) {
    const n = parseInt(q, 10);
    if (!Number.isNaN(n)) return n >>> 0;
  }
  return (Date.now() & 0xffffffff) >>> 0;
}

async function mount(selector, options = {}){
  const root =
    typeof selector === "string"
      ? document.querySelector(selector)
      : selector;
  if (!root) throw new Error("VernanWeb.mount: root element not found");

  const assetBase = options.assetBase ?? "../";
  if (!assetBase.endsWith("/")) throw new Error("assetBase must end with /");

  root.classList.add("vernan-web-root");
  root.innerHTML = `
    <div class="vernan-web-shell">
      <div class="vernan-web-canvas-wrap">
        <canvas class="vernan-web-canvas" width="${DISPLAY_WIDTH}" height="${DISPLAY_HEIGHT}" tabindex="0"></canvas>
        <div class="vernan-web-loading" data-loading>
          <span>Loading Vernan…</span>
          <div class="vernan-web-loading-bar"><div class="vernan-web-loading-bar-fill" data-progress></div></div>
        </div>
      </div>
      <div class="vernan-web-hud-bar">
        <span data-status>v${WEB_CLIENT_VERSION_STR}</span>
        <span data-fps></span>
      </div>
      <div class="vernan-web-touch" data-touch>
        <button type="button" class="vernan-touch-btn" data-touch="left">←</button>
        <button type="button" class="vernan-touch-btn" data-touch="jump">Jump</button>
        <button type="button" class="vernan-touch-btn" data-touch="right">→</button>
        <button type="button" class="vernan-touch-btn" data-touch="up">↑</button>
        <button type="button" class="vernan-touch-btn" data-touch="attack">Attack</button>
        <button type="button" class="vernan-touch-btn" data-touch="down">↓</button>
      </div>
      <p class="vernan-web-help">Move: WASD/Arrows · Jump: Z/Space · Attack: X · Subweapon: C · Debug: F3</p>
    </div>
  `;

  const canvas = root.querySelector(".vernan-web-canvas");
  const loadingEl = root.querySelector("[data-loading]");
  const progressEl = root.querySelector("[data-progress]");
  const fpsEl = root.querySelector("[data-fps]");
  const statusEl = root.querySelector("[data-status]");

  const loader = new AssetLoader(assetBase);
  const seed = parseSeed(options);

  let itemCatalog;
  const progressTimer = setInterval(() => {
    progressEl.style.width = Math.round(loader.progress() * 90) + "%";
  }, 50);
  try {
    await loader.loadCore();
    progressEl.style.width = "92%";
    itemCatalog = await ItemCatalog.load(assetBase);
    clearInterval(progressTimer);
    progressEl.style.width = "100%";
  } catch (err) {
    loadingEl.innerHTML = `<span class="vernan-web-banner error">Failed to load assets: ${String(err)}</span>`;
    throw err;
  }

  loadingEl.style.display = "none";
  canvas.focus();
  canvas.addEventListener("click", () => canvas.focus());

  const sim = new GameSim({ seed, assetLoader: loader, itemCatalog });
  const pipeline = new RenderPipeline(canvas);
  const input = new Input();
  const unbindInput = input.bind(canvas);

  statusEl.textContent = `v${WEB_CLIENT_VERSION_STR} · seed ${seed} · layout ${layoutHash(sim.layout)}`;

  // Touch controls
  const touchDown = new Set();
  const touchMap = {
    left: Keys.left,
    right: Keys.right,
    up: Keys.up,
    down: Keys.down,
    jump: Keys.jump,
    attack: Keys.attack,
  };
  const touchRoot = root.querySelector("[data-touch]");
  const onTouchStart = (e) => {
    const btn = (e.target).closest("[data-touch]");
    if (!btn) return;
    const action = btn.getAttribute("data-touch");
    if (action === "jump" || action === "attack") {
      e.preventDefault();
      const codes = touchMap[action];
      if (codes) for (const c of codes) input.injectPress(c);
      return;
    }
    if (!action) return;
    touchDown.add(action);
    e.preventDefault();
  };
  const onTouchEnd = (e) => {
    const btn = (e.target).closest("[data-touch]");
    if (!btn) return;
    const action = btn.getAttribute("data-touch") || "";
    touchDown.delete(action);
    const codes = touchMap[action];
    if (codes) for (const c of codes) input.setDown(c, false);
  };
  const onTouchTap = (e) => {
    const btn = (e.target).closest("[data-touch]");
    if (!btn) return;
    const action = btn.getAttribute("data-touch");
    if (action === "jump" || action === "attack") {
      const codes = touchMap[action];
      for (const c of codes) input.injectPress(c);
    }
  };
  touchRoot?.addEventListener("touchstart", onTouchStart, { passive: false });
  touchRoot?.addEventListener("touchend", onTouchEnd);
  touchRoot?.addEventListener("click", onTouchTap);

  const injectTouch = () => {
    for (const [action, codes] of Object.entries(touchMap)) {
      if (!touchDown.has(action)) continue;
      for (const c of codes) input.setDown(c, true);
    }
  };

  const loop = new GameLoop({
    update(dt) {
      injectTouch();
      if (anyPressed(input, Keys.debug)) sim.debugOverlay = !sim.debugOverlay;
      sim.update(dt, input);
    },
    render(alpha) {
      pipeline.draw(sim, sim.renderAlpha(alpha), loader);
    },
    onFpsUpdate(fps, ups) {
      fpsEl.textContent = `${fps} fps · ${ups} ups`;
      sim.fps = fps;
      sim.ups = ups;
    },
    endInputFrameAfterSimBatch(ran) {
      if (!ran) input.stashPressEdgesForSkippedSim();
      input.endFrame();
    },
  });

  loop.start();

  return () => {
    loop.stop();
    unbindInput();
    touchRoot?.removeEventListener("touchstart", onTouchStart);
    touchRoot?.removeEventListener("touchend", onTouchEnd);
    touchRoot?.removeEventListener("click", onTouchTap);
    root.innerHTML = "";
    root.classList.remove("vernan-web-root");
  };
}



  global.VernanWeb = {
    mount,
    WEB_CLIENT_VERSION: WEB_CLIENT_VERSION_STR,
    layoutHash,
    GameSim,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
