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
/** Sword overlay strip: 48×32 per frame (32px body + 16px reach extension on the right). */
const WEAPON_ATTACK_FRAME_W = 48;
const WEAPON_ATTACK_FRAME_H = 32;
const WEAPON_ATTACK_BODY_W = 32;
const WEAPON_ATTACK_EXTENSION_PX = 16;

const TILE_EMPTY = 0;
const TILE_SOLID = 1;
const TILE_DOOR = 2;
const TILE_PLATFORM = 3;
const TILE_LADDER = 4;
const TILE_BREAKABLE = 5;
const TILE_KEYBLOCK = 6;
const TILE_KEYBLOCK_CONNECTOR = 7;

const WEB_CLIENT_VERSION_STR = "0.1.25";

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

/** PLAYER_HURT / ENEMY_CRAWLER_HIT bounds with touch slop for sprite vs hitbox gap. */
function playerHurtRect(x, y, standH){
  const topInset = 5;
  return { x, y: y - topInset, w: 10, h: standH + topInset };
}

function crawlerContactRect(x, y){
  return { x: x - 1, y, w: 10, h: 12 };
}

function rectsOverlapSlack(a, b, slack = 4){
  return (
    a.x < b.x + b.w + slack &&
    a.x + a.w > b.x - slack &&
    a.y < b.y + b.h + slack &&
    a.y + a.h > b.y - slack
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

/** Java-compatible Random (48-bit LCG) for dungeon / room parity with desktop Vernan. */
function javaRandom(seed){
  const MULTIPLIER = 0x5deece66dn;
  const ADDEND = 0xbn;
  const MASK = (1n << 48n) - 1n;
  let state = (BigInt.asUintN(64, BigInt(seed)) ^ MULTIPLIER) & MASK;
  function next(bits){
    state = (state * MULTIPLIER + ADDEND) & MASK;
    return Number(state >> (48n - BigInt(bits)));
  }
  return {
    nextInt(bound){
      if (bound <= 0) return 0;
      if ((bound & -bound) === bound) return next(31) & (bound - 1);
      let bits;
      let val;
      do {
        bits = next(31);
        val = bits % bound;
      } while (bits - val + (bound - 1) < 0);
      return val;
    },
    nextDouble(){
      return (next(26) * 2 ** 27 + next(27)) / 2 ** 53;
    },
    nextBoolean(){
      return next(1) !== 0;
    },
  };
}

function shuffleInPlace(arr, rng){
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

function roomContentSeed(runSeed, roomId, gx, gy){
  const a = BigInt.asUintN(64, BigInt(runSeed));
  const b = BigInt(roomId) * 0x9e3779b97f4a7c15n;
  const c = BigInt(gx) * 0x51c3n;
  const d = BigInt(gy) * 0x1b873593n;
  return Number((a + b + c + d) & 0xffffffffffffffffn);
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

function isFloorTerrainTile(map, tx, ty) {
  const t = map.tileAt(tx, ty);
  return t === TILE_SOLID || t === TILE_BREAKABLE;
}

function solidAutotileCell(map, tx, ty) {
  const n = isFloorTerrainTile(map, tx, ty - 1);
  const s = isFloorTerrainTile(map, tx, ty + 1);
  const e = isFloorTerrainTile(map, tx + 1, ty);
  const w = isFloorTerrainTile(map, tx - 1, ty);
  const mask = (n ? 1 : 0) | (e ? 2 : 0) | (s ? 4 : 0) | (w ? 8 : 0);
  const cells = [
    [2, 2],
    [3, 1],
    [2, 1],
    [3, 1],
    [2, 0],
    [3, 0],
    [2, 0],
    [3, 0],
    [3, 2],
    [3, 2],
    [2, 2],
    [3, 2],
    [2, 2],
    [3, 2],
    [2, 2],
    [2, 2],
  ];
  return cells[mask] || [2, 2];
}

function resolveAssetUrl(assetBase, relPath){
  try {
    return new URL(relPath, assetBase).href;
  } catch (_e) {
    return assetBase + relPath;
  }
}

/** True when an HTMLImageElement is safe to pass to drawImage. */
function imageDrawable(img){
  if (!img) return false;
  if (img instanceof HTMLImageElement) {
    if (img.naturalWidth > 0 && img.naturalHeight > 0) return true;
    if (img.complete && img.width > 0 && img.height > 0) return true;
    return false;
  }
  return typeof img.width === "number" && img.width > 0;
}

function drawForestTile(ctx, sheet, col, row, px, py) {
  if (!imageDrawable(sheet)) return false;
  try {
    ctx.drawImage(sheet, col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE, px, py, TILE_SIZE, TILE_SIZE);
    return true;
  } catch (_e) {
    return false;
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

  static generate(runSeed, targetRooms = 12, roomWidthTiles = 24, bonusSecretRooms = 0, bonusSuperSecretRooms = 0){
    const w = Math.max(24, roomWidthTiles);
    const n = clamp(targetRooms, 6, 24);
    const targetSecrets = 1 + Math.max(0, bonusSecretRooms);
    const targetSuperSecrets = 1 + Math.max(0, bonusSuperSecretRooms);
    const SPECIAL_ROOM_ATTEMPTS = 256;

    for (let attempt = 0; attempt < SPECIAL_ROOM_ATTEMPTS; attempt++) {
      const salt = Number(BigInt(runSeed) ^ (BigInt(attempt) * 0x9e3779b97f4a7c15n));
      const rng = javaRandom(Number(BigInt(salt) ^ 0xc0ffeeb00ban));
      const g = buildDungeonGraph(rng, n, w, runSeed);
      if (!canPlaceSpecialRooms(g.rooms)) continue;
      assignSpecialRoomKinds(g.rooms, rng);
      const laid = tryInsertSecrets(cloneLayout(new DungeonLayout(g.rooms, g.cellToId)), rng, w, targetSecrets, targetSuperSecrets);
      if (laid) return laid;
    }

    for (let attempt = 0; attempt < SPECIAL_ROOM_ATTEMPTS; attempt++) {
      const salt = Number(BigInt(runSeed) ^ 0xdeadbeefn ^ (BigInt(attempt) * 0x9e3779b97f4a7c15n));
      const rng = javaRandom(Number(BigInt(salt) ^ 0xc0ffeeb00ban));
      const g = buildDungeonGraph(rng, n, w, runSeed);
      assignSpecialRoomKindsRelaxed(g.rooms, rng);
      const laid = tryInsertSecrets(cloneLayout(new DungeonLayout(g.rooms, g.cellToId)), rng, w, targetSecrets, targetSuperSecrets);
      if (laid) return laid;
    }

    const rng = javaRandom(Number(BigInt(runSeed) ^ 0xdeadbeefdeadbeefn ^ 0xc0ffeeb00ban));
    const g = buildDungeonGraph(rng, n, w, runSeed);
    assignSpecialRoomKindsRelaxed(g.rooms, rng);
    return secretRoomGraphPlacerInsert(
      cloneLayout(new DungeonLayout(g.rooms, g.cellToId)),
      rng,
      w,
      targetSecrets,
      targetSuperSecrets
    ).layout;
  }
}

function buildDungeonGraph(rng, n, w, runSeed){
  const cells = [[0, 0]];
  const index = new Map([[key(0, 0), 0]]);
  if (n >= 2) {
    cells.push([0, 1]);
    index.set(key(0, 1), 1);
  }

  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  while (cells.length < n) {
    const pick = pickExpansionCell(cells, index, rng);
    const gx = cells[pick][0];
    const gy = cells[pick][1];
    const shuffled = dirs.map((d) => d.slice());
    shuffleInPlace(shuffled, rng);

    let added = false;
    for (const d of shuffled) {
      const nx = gx + d[0];
      const ny = gy + d[1];
      if (Math.abs(nx) > 6 || Math.abs(ny) > 6) continue;
      const k = key(nx, ny);
      if (index.has(k)) continue;
      index.set(k, cells.length);
      cells.push([nx, ny]);
      added = true;
      break;
    }
    if (!added) {
      let any = false;
      for (let attempt = 0; attempt < cells.length * 4; attempt++) {
        const j = rng.nextInt(cells.length);
        const cx = cells[j][0];
        const cy = cells[j][1];
        const d = dirs[rng.nextInt(4)];
        const nx = cx + d[0];
        const ny = cy + d[1];
        if (Math.abs(nx) > 6 || Math.abs(ny) > 6) continue;
        const k = key(nx, ny);
        if (index.has(k)) continue;
        index.set(k, cells.length);
        cells.push([nx, ny]);
        any = true;
        break;
      }
      if (!any) break;
    }
  }

  const count = cells.length;
  const doorW = new Array(count).fill(false);
  const doorE = new Array(count).fill(false);
  const ladN = new Array(count).fill(false);
  const ladS = new Array(count).fill(false);
  const ladderTx = new Array(count).fill(-1);

  for (let i = 0; i < count; i++) {
    const gx = cells[i][0];
    const gy = cells[i][1];
    if (index.has(key(gx - 1, gy))) doorW[i] = true;
    if (index.has(key(gx + 1, gy))) doorE[i] = true;
    if (index.has(key(gx, gy - 1))) ladN[i] = true;
    if (index.has(key(gx, gy + 1))) ladS[i] = true;
  }

  const ladderMin = 8;
  const ladderMaxExcl = Math.max(ladderMin + 1, w - 8);
  const ladderSpan = ladderMaxExcl - ladderMin;
  for (let i = 0; i < count; i++) {
    if (!ladS[i]) continue;
    const gx = cells[i][0];
    const gy = cells[i][1];
    const j = index.get(key(gx, gy + 1));
    if (j == null) continue;
    let L;
    if (ladderTx[i] >= 0) L = ladderTx[i];
    else if (ladderTx[j] >= 0) L = ladderTx[j];
    else L = ladderMin + (ladderSpan > 0 ? rng.nextInt(ladderSpan) : 0);
    ladderTx[i] = L;
    ladderTx[j] = L;
  }

  for (let i = 0; i < count; i++) {
    if (!ladN[i] && !ladS[i]) continue;
    if (ladderTx[i] >= 0) continue;
    const gx = cells[i][0];
    const gy = cells[i][1];
    let L = ladderMin + (ladderSpan > 0 ? rng.nextInt(ladderSpan) : 0);
    if (ladS[i]) {
      const j = index.get(key(gx, gy + 1));
      if (j != null) {
        ladderTx[i] = L;
        ladderTx[j] = L;
      }
    } else if (ladN[i]) {
      const j = index.get(key(gx, gy - 1));
      if (j != null) {
        if (ladderTx[j] >= 0) L = ladderTx[j];
        ladderTx[i] = L;
        ladderTx[j] = L;
      }
    }
  }

  const rooms = [];
  const cellToId = new Map();
  for (let i = 0; i < count; i++) {
    const gx = cells[i][0];
    const gy = cells[i][1];
    cellToId.set(key(gx, gy), i);
    rooms.push({
      id: i,
      gridX: gx,
      gridY: gy,
      contentSeed: roomContentSeed(runSeed, i, gx, gy),
      doorWest: doorW[i],
      doorEast: doorE[i],
      ladderNorth: ladN[i],
      ladderSouth: ladS[i],
      ladderColumnTx: ladderTx[i],
      kind: RoomKind.NORMAL,
    });
  }
  return { rooms, cellToId };
}

function pickExpansionCell(cells, index, rng){
  const leafIdx = [];
  for (let i = 0; i < cells.length; i++) {
    const gx = cells[i][0];
    const gy = cells[i][1];
    let deg = 0;
    if (index.has(key(gx - 1, gy))) deg++;
    if (index.has(key(gx + 1, gy))) deg++;
    if (index.has(key(gx, gy - 1))) deg++;
    if (index.has(key(gx, gy + 1))) deg++;
    if (deg === 1) leafIdx.push(i);
  }
  if (leafIdx.length > 0 && rng.nextDouble() < 0.65) {
    return leafIdx[rng.nextInt(leafIdx.length)];
  }
  return rng.nextInt(cells.length);
}

function graphDegree(r){
  return (r.doorWest ? 1 : 0) + (r.doorEast ? 1 : 0) + (r.ladderNorth ? 1 : 0) + (r.ladderSouth ? 1 : 0);
}

function isAdjacentToStart(rooms, roomId){
  const a = rooms[0];
  const b = rooms[roomId];
  const dx = Math.abs(a.gridX - b.gridX);
  const dy = Math.abs(a.gridY - b.gridY);
  return (dx === 1 && dy === 0) || (dx === 0 && dy === 1);
}

function canPlaceSpecialRooms(rooms){
  let leaves = 0;
  let bossOkApartFromStart = 0;
  for (let id = 1; id < rooms.length; id++) {
    const r = rooms[id];
    if (graphDegree(r) === 1) leaves++;
    const horiz = (r.doorWest ? 1 : 0) + (r.doorEast ? 1 : 0);
    if (horiz === 1 && !r.ladderNorth && !r.ladderSouth && !isAdjacentToStart(rooms, id)) {
      bossOkApartFromStart++;
    }
  }
  return bossOkApartFromStart >= 1 && leaves >= 3;
}

function assignSpecialRoomKinds(rooms, rng){
  const kinds = rooms.map(() => RoomKind.NORMAL);
  kinds[0] = RoomKind.START;

  const leaves = [];
  const bossEligible = [];
  for (let id = 1; id < rooms.length; id++) {
    const r = rooms[id];
    if (graphDegree(r) === 1) leaves.push(id);
    const horiz = (r.doorWest ? 1 : 0) + (r.doorEast ? 1 : 0);
    if (horiz === 1 && !r.ladderNorth && !r.ladderSouth && !isAdjacentToStart(rooms, id)) {
      bossEligible.push(id);
    }
  }
  shuffleInPlace(leaves, rng);
  shuffleInPlace(bossEligible, rng);

  const bossId = bossEligible[0];
  kinds[bossId] = RoomKind.BOSS;

  let itemId = -1;
  for (const id of leaves) {
    if (id !== bossId) {
      itemId = id;
      kinds[id] = RoomKind.ITEM;
      break;
    }
  }
  for (const id of leaves) {
    if (id !== bossId && id !== itemId) {
      kinds[id] = RoomKind.SHOP;
      break;
    }
  }

  for (let i = 0; i < rooms.length; i++) {
    rooms[i].kind = kinds[i];
  }
}

function assignSpecialRoomKindsRelaxed(rooms, rng){
  const kinds = rooms.map(() => RoomKind.NORMAL);
  kinds[0] = RoomKind.START;

  const pool = [];
  for (let id = 1; id < rooms.length; id++) pool.push(id);
  shuffleInPlace(pool, rng);

  const bossEligible = [];
  const bossEligibleNearStart = [];
  for (let id = 1; id < rooms.length; id++) {
    const r = rooms[id];
    const horiz = (r.doorWest ? 1 : 0) + (r.doorEast ? 1 : 0);
    if (horiz === 1 && !r.ladderNorth && !r.ladderSouth) {
      (isAdjacentToStart(rooms, id) ? bossEligibleNearStart : bossEligible).push(id);
    }
  }
  shuffleInPlace(bossEligible, rng);
  shuffleInPlace(bossEligibleNearStart, rng);

  if (bossEligible.length > 0) kinds[bossEligible[0]] = RoomKind.BOSS;
  else if (bossEligibleNearStart.length > 0) kinds[bossEligibleNearStart[0]] = RoomKind.BOSS;
  else if (pool.length > 0) kinds[pool[0]] = RoomKind.BOSS;

  for (const id of pool) {
    if (kinds[id] === RoomKind.NORMAL) {
      kinds[id] = RoomKind.ITEM;
      break;
    }
  }
  for (const id of pool) {
    if (kinds[id] === RoomKind.NORMAL) {
      kinds[id] = RoomKind.SHOP;
      break;
    }
  }

  for (let i = 0; i < rooms.length; i++) {
    rooms[i].kind = kinds[i];
  }
}

function cloneLayout(layout){
  const rooms = layout.allRooms().map((r) => ({ ...r }));
  const cellToId = new Map(layout.cellToId);
  return new DungeonLayout(rooms, cellToId);
}

function isSecretKind(kind){
  return kind === RoomKind.SECRET || kind === RoomKind.SUPER_SECRET;
}

function tryInsertSecrets(baseLayout, rng, w, targetSecrets, targetSuperSecrets){
  const result = secretRoomGraphPlacerInsert(baseLayout, rng, w, targetSecrets, targetSuperSecrets);
  if (result.secretsPlaced >= targetSecrets && result.superSecretsPlaced >= targetSuperSecrets) {
    return result.layout;
  }
  return null;
}

function secretRoomGraphPlacerInsert(base, rng, roomWidthTiles, targetSecrets, targetSuperSecrets){
  const list = base.allRooms().map((r) => ({ ...r }));
  const cell = new Map(base.cellToId);
  let secretsPlaced = 0;
  for (let n = 0; n < targetSecrets; n++) {
    if (!placeOneSecretRoom(list, cell, roomWidthTiles, rng)) break;
    secretsPlaced++;
  }
  let superSecretsPlaced = 0;
  for (let n = 0; n < targetSuperSecrets; n++) {
    if (!placeOneSuperSecretRoom(list, cell, roomWidthTiles, rng)) break;
    superSecretsPlaced++;
  }
  return { layout: new DungeonLayout(list, cell), secretsPlaced, superSecretsPlaced };
}

function graphDegreeAt(cell, gx, gy){
  let d = 0;
  if (cell.has(key(gx - 1, gy))) d++;
  if (cell.has(key(gx + 1, gy))) d++;
  if (cell.has(key(gx, gy - 1))) d++;
  if (cell.has(key(gx, gy + 1))) d++;
  return d;
}

function emptyAdjacentCandidates(cell){
  const seen = new Set();
  const out = [];
  for (const k of [...cell.keys()]) {
    const comma = k.indexOf(",");
    const gx = Number(k.slice(0, comma));
    const gy = Number(k.slice(comma + 1));
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = gx + dx;
      const ny = gy + dy;
      if (Math.abs(nx) > 7 || Math.abs(ny) > 7) continue;
      const nk = key(nx, ny);
      if (cell.has(nk) || seen.has(nk)) continue;
      seen.add(nk);
      out.push([nx, ny]);
    }
  }
  return out;
}

function rankedSecretCandidates(cell, rng){
  const candidates = emptyAdjacentCandidates(cell);
  shuffleInPlace(candidates, rng);
  candidates.sort((a, b) => graphDegreeAt(cell, b[0], b[1]) - graphDegreeAt(cell, a[0], a[1]));
  return candidates;
}

function neighborRoomIdsAt(cell, list, gx, gy){
  const out = [];
  const w = cell.get(key(gx - 1, gy));
  const e = cell.get(key(gx + 1, gy));
  const n = cell.get(key(gx, gy - 1));
  const s = cell.get(key(gx, gy + 1));
  if (w != null) out.push(w);
  if (e != null) out.push(e);
  if (n != null) out.push(n);
  if (s != null) out.push(s);
  return out;
}

function okSecretPlacement(list, cell, gx, gy){
  if (graphDegreeAt(cell, gx, gy) < 1) return false;
  for (const id of neighborRoomIdsAt(cell, list, gx, gy)) {
    const k = list[id].kind;
    if (k === RoomKind.BOSS || k === RoomKind.SUPER_SECRET) return false;
  }
  return true;
}

function okSuperSecretPlacement(list, cell, gx, gy){
  if (graphDegreeAt(cell, gx, gy) !== 1) return false;
  for (const id of neighborRoomIdsAt(cell, list, gx, gy)) {
    const k = list[id].kind;
    if (k !== RoomKind.NORMAL && k !== RoomKind.START) return false;
  }
  return true;
}

function withDoorEastRoom(r, doorEast){
  return { ...r, doorEast };
}
function withDoorWestRoom(r, doorWest){
  return { ...r, doorWest };
}
function withLadderSouthRoom(r, ladderSouth, ladderTx){
  return { ...r, ladderSouth, ladderColumnTx: ladderTx >= 0 ? ladderTx : r.ladderColumnTx };
}
function withLadderNorthRoom(r, ladderNorth, ladderTx){
  return { ...r, ladderNorth, ladderColumnTx: ladderTx >= 0 ? ladderTx : r.ladderColumnTx };
}

function pickSecretLadderTx(list, nn, ns, wTiles, rng, needLadder){
  if (!needLadder) return -1;
  const cand = [];
  if (nn != null && list[nn].ladderColumnTx >= 0) cand.push(list[nn].ladderColumnTx);
  if (ns != null && list[ns].ladderColumnTx >= 0) cand.push(list[ns].ladderColumnTx);
  let L;
  if (cand.length === 0) {
    const ladderMin = 8;
    const ladderMaxExcl = Math.max(ladderMin + 1, wTiles - 8);
    const span = ladderMaxExcl - ladderMin;
    L = ladderMin + (span > 0 ? rng.nextInt(span) : 0);
  } else {
    L = Math.round(cand.reduce((a, b) => a + b, 0) / cand.length);
  }
  return clamp(L, 3, wTiles - 4);
}

function addSecretGraphRoom(list, cell, gx, gy, kind, roomWidthTiles, rng){
  const nw = cell.get(key(gx - 1, gy));
  const ne = cell.get(key(gx + 1, gy));
  const nn = cell.get(key(gx, gy - 1));
  const ns = cell.get(key(gx, gy + 1));
  const doorW = nw != null;
  const doorE = ne != null;
  const ladN = nn != null;
  const ladS = ns != null;
  const wTiles = Math.max(24, roomWidthTiles);
  const ladderTx = pickSecretLadderTx(list, nn, ns, wTiles, rng, ladN || ladS);
  const newId = list.length;
  const contentSeed = Number(
    BigInt(rng.nextInt(0x7fffffff)) ^
      BigInt(gx) * 0x51c3n ^
      BigInt(gy) * 0x1b873593n ^
      BigInt(kind === RoomKind.SECRET ? 1 : 2) * 0x9e3779b97f4a7c15n
  );
  list.push({
    id: newId,
    gridX: gx,
    gridY: gy,
    contentSeed,
    doorWest: doorW,
    doorEast: doorE,
    ladderNorth: ladN,
    ladderSouth: ladS,
    ladderColumnTx: ladderTx,
    kind,
  });
  cell.set(key(gx, gy), newId);
  if (nw != null) list[nw] = withDoorEastRoom(list[nw], true);
  if (ne != null) list[ne] = withDoorWestRoom(list[ne], true);
  if (nn != null) list[nn] = withLadderSouthRoom(list[nn], true, ladderTx);
  if (ns != null) list[ns] = withLadderNorthRoom(list[ns], true, ladderTx);
}

function placeOneSecretRoom(list, cell, roomWidthTiles, rng){
  const candidates = rankedSecretCandidates(cell, rng);
  if (tryPlaceSecretAtDegree(list, cell, roomWidthTiles, rng, candidates, 2)) return true;
  return tryPlaceSecretAtDegree(list, cell, roomWidthTiles, rng, candidates, 1);
}

function tryPlaceSecretAtDegree(list, cell, roomWidthTiles, rng, candidates, minDegree){
  for (const [gx, gy] of candidates) {
    if (graphDegreeAt(cell, gx, gy) < minDegree) continue;
    if (!okSecretPlacement(list, cell, gx, gy)) continue;
    addSecretGraphRoom(list, cell, gx, gy, RoomKind.SECRET, roomWidthTiles, rng);
    return true;
  }
  return false;
}

function placeOneSuperSecretRoom(list, cell, roomWidthTiles, rng){
  const candidates = emptyAdjacentCandidates(cell);
  shuffleInPlace(candidates, rng);
  for (const [gx, gy] of candidates) {
    if (!okSuperSecretPlacement(list, cell, gx, gy)) continue;
    addSecretGraphRoom(list, cell, gx, gy, RoomKind.SUPER_SECRET, roomWidthTiles, rng);
    return true;
  }
  return false;
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

const MINIMAP_CELL_W = 7;
const MINIMAP_CELL_H = 5;
const MINIMAP_CELL_GAP = 2;
const MINIMAP_ALPHA_VISITED = 230 / 255;
const MINIMAP_ALPHA_UNVISITED = 130 / 255;
const MINIMAP_ALPHA_CURRENT = 250 / 255;

function minimapKindRgb(kind){
  switch (kind) {
    case RoomKind.START:
      return [120, 200, 255];
    case RoomKind.ITEM:
      return [255, 210, 80];
    case RoomKind.SHOP:
      return [180, 140, 255];
    case RoomKind.BOSS:
      return [255, 90, 90];
    case RoomKind.SECRET:
      return [90, 200, 160];
    case RoomKind.SUPER_SECRET:
      return [160, 120, 220];
    default:
      return [200, 200, 210];
  }
}

function minimapGridMetrics(layout){
  const rooms = layout.allRooms();
  let minGx = Infinity;
  let minGy = Infinity;
  let maxGx = -Infinity;
  let maxGy = -Infinity;
  for (const r of rooms) {
    minGx = Math.min(minGx, r.gridX);
    minGy = Math.min(minGy, r.gridY);
    maxGx = Math.max(maxGx, r.gridX);
    maxGy = Math.max(maxGy, r.gridY);
  }
  const cols = maxGx - minGx + 1;
  const rows = maxGy - minGy + 1;
  return {
    minGx,
    minGy,
    cols,
    rows,
    totalW: cols * MINIMAP_CELL_W + (cols - 1) * MINIMAP_CELL_GAP,
    totalH: rows * MINIMAP_CELL_H + (rows - 1) * MINIMAP_CELL_GAP,
  };
}

function minimapRoomAdjacentToCurrent(layout, currentRoomId, roomId){
  if (currentRoomId < 0) return false;
  return (
    layout.neighborWest(currentRoomId) === roomId ||
    layout.neighborEast(currentRoomId) === roomId ||
    layout.neighborNorth(currentRoomId) === roomId ||
    layout.neighborSouth(currentRoomId) === roomId
  );
}

function drawMinimap(ctx, snap, hudY){
  const layout = snap.layout;
  if (!layout || layout.roomCount() === 0) return;
  const grid = minimapGridMetrics(layout);
  const x0 = Math.max(6, INTERNAL_WIDTH - grid.totalW - 8);
  const y0 = hudY + Math.floor((HUD_HEIGHT - grid.totalH) / 2);

  ctx.fillStyle = "rgba(0,0,0,0.47)";
  ctx.fillRect(x0 - 2, y0 - 2, grid.totalW + 4, grid.totalH + 4);

  for (const n of layout.allRooms()) {
    const cx = n.gridX - grid.minGx;
    const cy = n.gridY - grid.minGy;
    const x = x0 + cx * (MINIMAP_CELL_W + MINIMAP_CELL_GAP);
    const y = y0 + cy * (MINIMAP_CELL_H + MINIMAP_CELL_GAP);
    const current = n.id === snap.currentRoomId;
    const visited = n.id < snap.roomVisited.length && snap.roomVisited[n.id];
    const adjacentNow =
      !current && minimapRoomAdjacentToCurrent(layout, snap.currentRoomId, n.id);
    const secretKind = n.kind === RoomKind.SECRET || n.kind === RoomKind.SUPER_SECRET;
    const adjacentRemembered =
      !current &&
      !secretKind &&
      n.id < snap.minimapAdjacentSeen.length &&
      snap.minimapAdjacentSeen[n.id];
    const showRoom = secretKind
      ? current || visited
      : visited || current || adjacentNow || adjacentRemembered;
    if (!showRoom) continue;

    const [r, g, b] = minimapKindRgb(n.kind);
    if (current) {
      ctx.fillStyle = `rgba(${r},${g},${b},${MINIMAP_ALPHA_CURRENT})`;
      ctx.fillRect(x, y, MINIMAP_CELL_W, MINIMAP_CELL_H);
      ctx.strokeStyle = "#ffffff";
      ctx.strokeRect(x + 0.5, y + 0.5, MINIMAP_CELL_W - 1, MINIMAP_CELL_H - 1);
    } else {
      const alpha = visited ? MINIMAP_ALPHA_VISITED : MINIMAP_ALPHA_UNVISITED;
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.fillRect(x, y, MINIMAP_CELL_W, MINIMAP_CELL_H);
    }
  }
}

  // --- world/RoomGenerator.ts ---





const WIDE_W = Math.max(64, WORLD_VIEWPORT_W / TILE_SIZE);
const WIDE_H = Math.max(12, WORLD_VIEWPORT_H / TILE_SIZE);
const SCREEN_W = Math.max(10, Math.ceil(WORLD_VIEWPORT_W / TILE_SIZE));
const SCREEN_H = Math.max(8, Math.ceil(WORLD_VIEWPORT_H / TILE_SIZE));
const STANDARD_TERRAIN_REACH_FROM_GRID_Y = 4;
const EASY_TERRAIN_MAX_VERTICAL_REACH_TILES = 2;
const STANDARD_TERRAIN_MAX_VERTICAL_REACH_TILES = 3;

function isOneScreenRoomKind(k){
  return k !== RoomKind.NORMAL && k !== RoomKind.SECRET;
}

function usesFlatLadderFloorKind(kind){
  return (
    kind === RoomKind.START ||
    kind === RoomKind.NORMAL ||
    kind === RoomKind.SHOP ||
    kind === RoomKind.SUPER_SECRET
  );
}

function maxVerticalReachTilesForGridY(gridY){
  return gridY < STANDARD_TERRAIN_REACH_FROM_GRID_Y
    ? EASY_TERRAIN_MAX_VERTICAL_REACH_TILES
    : STANDARD_TERRAIN_MAX_VERTICAL_REACH_TILES;
}

function valueNoise1D(seed, n, periodTiles){
  const r = javaRandom(seed);
  const period = Math.max(2, periodTiles);
  const points = Math.floor(n / period) + 3;
  const knots = new Array(points);
  for (let i = 0; i < points; i++) knots[i] = r.nextDouble() * 2 - 1;
  const out = new Array(n);
  for (let x = 0; x < n; x++) {
    const t = x / period;
    const i0 = Math.floor(t);
    const f = t - i0;
    const a = knots[i0];
    const b = knots[i0 + 1];
    const s = f * f * (3 - 2 * f);
    out[x] = a + (b - a) * s;
  }
  return out;
}

function flattenGroundRun(groundY, lo, hi){
  if (lo > hi) return;
  let t = groundY[lo];
  for (let x = lo; x <= hi; x++) t = Math.max(t, groundY[x]);
  for (let x = lo; x <= hi; x++) groundY[x] = t;
}

function enforceMaxWalkableGroundYStep(groundY, maxStep){
  const w = groundY.length;
  for (let pass = 0; pass < w; pass++) {
    let changed = false;
    for (let x = 1; x < w; x++) {
      if (groundY[x] - groundY[x - 1] > maxStep) {
        groundY[x] = groundY[x - 1] + maxStep;
        changed = true;
      }
      if (groundY[x - 1] - groundY[x] > maxStep) {
        groundY[x - 1] = groundY[x] + maxStep;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

function flankPlayFloorRowFromGroundY(groundY, flankTx){
  const col = clamp(flankTx, 1, groundY.length - 2);
  return groundY[col];
}

function resolvedLadderRunwayRowOnGrid(grid, w, h, groundY, ladderTx, ladderSouth){
  const l = clamp(ladderTx, 1, w - 2);
  const left = flankPlayFloorRowFromGroundY(groundY, l - 1);
  const right = flankPlayFloorRowFromGroundY(groundY, l + 1);
  if (left !== right) return ladderSouth ? Math.max(left, right) : Math.min(left, right);
  return left;
}

function gridToAsciiRows(grid){
  return grid.map((row) => row.join(""));
}

const MAX_TRAVERSAL_LADDER_TOP_ROW = 2;
const MAX_TRAVERSAL_LADDER_RUNGS = 6;

function clampLadderColumn(mapWidth, layoutL){
  if (layoutL < 0) return -1;
  return clamp(layoutL, 3, mapWidth - 4);
}

function roomLadderColumnTx(node, map){
  return clampLadderColumn(map.getWidth(), node.ladderColumnTx);
}

function truncateLadderRunsOnGrid(grid, h, tx, floorRow){
  let runBottom = -1;
  let rungs = 0;
  const flush = () => {
    if (runBottom < 0) return;
    if (rungs > MAX_TRAVERSAL_LADDER_RUNGS) {
      const keepFrom = runBottom + rungs - MAX_TRAVERSAL_LADDER_RUNGS;
      for (let yy = runBottom; yy < keepFrom; yy++) grid[yy][tx] = ".";
    }
    runBottom = -1;
    rungs = 0;
  };
  for (let y = MAX_TRAVERSAL_LADDER_TOP_ROW; y <= floorRow; y++) {
    if (grid[y][tx] === "H") {
      if (runBottom < 0) runBottom = y;
      rungs++;
    } else {
      flush();
    }
  }
  flush();
}

/** Remove decorative procedural ladders that are not the dungeon vertical shaft (Java DungeonVerticalShaftRules). */
function stripSpuriousLaddersFromGrid(grid, w, h, shaftColumnL, groundY){
  if (!groundY) return;
  for (let tx = 1; tx < w - 1; tx++) {
    if (shaftColumnL >= 1 && tx === shaftColumnL) continue;
    const lipRow = clamp(groundY[tx], 1, h - 2);
    for (let y = lipRow + 1; y < h - 1; y++) {
      if (grid[y][tx] === "H") grid[y][tx] = "#";
    }
    if (h > 1 && grid[h - 1][tx] === "H") grid[h - 1][tx] = "#";
    for (let y = 0; y < MAX_TRAVERSAL_LADDER_TOP_ROW && y < h; y++) {
      if (grid[y][tx] === "H") grid[y][tx] = "#";
    }
    if (lipRow >= 1 && lipRow < h - 1 && grid[lipRow][tx] === "-") {
      grid[lipRow][tx] = "#";
    }
    if (
      lipRow >= 1 &&
      lipRow < h - 1 &&
      grid[lipRow][tx] === "-" &&
      grid[lipRow + 1][tx] === "H"
    ) {
      grid[lipRow][tx] = "#";
    }
    truncateLadderRunsOnGrid(grid, h, tx, lipRow);
  }
}

/** LADDER-MOUTH-2: south mouth deck at runway row so VERT-TRANS-SOUTH can pass. */
function finalizeDungeonLadderMouthOnGrid(grid, w, h, ladderTx, mouthRow, conn){
  const L = ladderTx;
  if (L < 1 || L >= w - 1 || mouthRow < 1 || mouthRow >= h - 1) return;
  if (conn.ladderSouth) {
    if (grid[mouthRow][L] !== "D") grid[mouthRow][L] = "-";
    for (let y = 1; y < mouthRow; y++) {
      if (grid[y][L] === "D") continue;
      if (grid[y][L] === "#" || grid[y][L] === "-") grid[y][L] = "H";
    }
    for (let y = mouthRow + 1; y < h - 1; y++) {
      if (grid[y][L] === "D") continue;
      if (grid[y][L] === "#" || grid[y][L] === "-") grid[y][L] = "H";
    }
    if (grid[h - 1][L] !== "D") grid[h - 1][L] = "H";
  } else if (conn.ladderNorth) {
    if (grid[mouthRow][L] !== "D") grid[mouthRow][L] = "#";
    for (let y = mouthRow + 1; y < h - 1; y++) {
      if (grid[y][L] === "D") continue;
      grid[y][L] = "#";
    }
  }
}

const SECRET_RUNWAY_TILES = 8;
const SECRET_ROOM_ENEMY_CHANCE = 0.08;
const SEAM_KIND_HORIZONTAL = "HORIZONTAL_DOOR";
const SEAM_KIND_VERTICAL = "VERTICAL_LADDER";
const SEAM_ROLE_BREAKABLE = "BREAKABLE";
const SEAM_ROLE_BUFFER_WEST = "BUFFER_WEST";
const SEAM_ROLE_BUFFER_EAST = "BUFFER_EAST";
const SEAM_ROLE_BUFFER = "BUFFER";

function secretRoomSeams(layout, secretRoomId, rooms){
  const edges = [];
  const w = layout.neighborWest(secretRoomId);
  if (w >= 0 && rooms[w] && !isSecretKind(layout.room(w).kind) && rooms[w].rightDoorTopTileY >= 0) {
    edges.push({ secretEastFace: false, neighborDoorTopY: rooms[w].rightDoorTopTileY });
  }
  const e = layout.neighborEast(secretRoomId);
  if (e >= 0 && rooms[e] && !isSecretKind(layout.room(e).kind) && rooms[e].leftDoorTopTileY >= 0) {
    edges.push({ secretEastFace: true, neighborDoorTopY: rooms[e].leftDoorTopTileY });
  }
  return {
    edges,
    superSecretFlatArena: layout.room(secretRoomId).kind === RoomKind.SUPER_SECRET,
  };
}

function neighborSecretFaces(layout, roomId){
  const e = layout.neighborEast(roomId);
  const w = layout.neighborWest(roomId);
  return {
    finishEastFace: e >= 0 && isSecretKind(layout.room(e).kind),
    finishWestFace: w >= 0 && isSecretKind(layout.room(w).kind),
  };
}

function plannedRoomWidths(layout){
  const n = layout.roomCount();
  const out = new Array(n);
  for (let id = 0; id < n; id++) out[id] = plannedRoomWidth(layout, id);
  return out;
}

function plannedRoomHeights(layout){
  const n = layout.roomCount();
  const out = new Array(n);
  for (let id = 0; id < n; id++) out[id] = plannedRoomHeight(layout, id);
  return out;
}

function plannedRoomWidth(layout, roomId){
  const kind = layout.room(roomId).kind;
  let w = kind === RoomKind.SECRET ? WIDE_W : isOneScreenRoomKind(kind) ? SCREEN_W : WIDE_W;
  const node = layout.room(roomId);
  if (shouldExpandWest(layout, roomId) || (kind === RoomKind.SECRET && !node.doorWest)) w++;
  if (shouldExpandEast(layout, roomId) || (kind === RoomKind.SECRET && !node.doorEast)) w++;
  return w;
}

function plannedRoomHeight(layout, roomId){
  const kind = layout.room(roomId).kind;
  let h = kind === RoomKind.SECRET ? WIDE_H : isOneScreenRoomKind(kind) ? SCREEN_H : WIDE_H;
  if (shouldExpandNorth(layout, roomId)) h++;
  if (shouldExpandSouth(layout, roomId)) h++;
  return h;
}

function shouldExpandToward(layout, roomId, neighborId){
  if (neighborId < 0) return false;
  return isSecretKind(layout.room(roomId).kind) !== isSecretKind(layout.room(neighborId).kind);
}
function shouldExpandWest(layout, roomId){
  return shouldExpandToward(layout, roomId, layout.neighborWest(roomId));
}
function shouldExpandEast(layout, roomId){
  return shouldExpandToward(layout, roomId, layout.neighborEast(roomId));
}
function shouldExpandNorth(layout, roomId){
  return shouldExpandToward(layout, roomId, layout.neighborNorth(roomId));
}
function shouldExpandSouth(layout, roomId){
  return shouldExpandToward(layout, roomId, layout.neighborSouth(roomId));
}

function seamPlayFloorRow(neighborDoorTopY, mapHeight){
  return Math.min(mapHeight - 2, neighborDoorTopY + 2);
}

function alignAsciiGroundYToSeams(groundY, w, h, secretSeams){
  if (!secretSeams?.edges?.length) return;
  let maxFloor = -1;
  for (const e of secretSeams.edges) {
    const floor = seamPlayFloorRow(e.neighborDoorTopY, h);
    maxFloor = maxFloor < 0 ? floor : Math.max(maxFloor, floor);
    const doorX = e.secretEastFace ? w - 2 : 1;
    const runwayLo = e.secretEastFace ? Math.max(1, doorX - SECRET_RUNWAY_TILES) : doorX;
    const runwayHi = e.secretEastFace ? doorX : Math.min(w - 2, doorX + SECRET_RUNWAY_TILES);
    for (let x = runwayLo; x <= runwayHi; x++) groundY[x] = floor;
  }
  if (secretSeams.superSecretFlatArena && maxFloor >= 0) groundY.fill(maxFloor);
}

function carveHorizontalFace(map, doorX, doorTopY, eastFace, ladderTx, breakableDoor){
  const h = map.getHeight();
  const w = map.getWidth();
  const doorTop = clamp(doorTopY, 1, h - 4);
  const groundY = Math.min(h - 2, doorTop + 2);
  const runwayLo = eastFace ? Math.max(1, doorX - SECRET_RUNWAY_TILES) : doorX;
  const runwayHi = eastFace ? doorX : Math.min(w - 2, doorX + SECRET_RUNWAY_TILES);
  for (let x = runwayLo; x <= runwayHi; x++) {
    for (let y = 1; y < h - 1; y++) {
      const t = map.tileAt(x, y);
      if (t === TILE_DOOR || t === TILE_BREAKABLE) continue;
      map.setTile(x, y, TILE_EMPTY);
    }
    for (let y = groundY; y < h - 1; y++) map.setTile(x, y, TILE_SOLID);
  }
  const doorTile = breakableDoor ? TILE_BREAKABLE : TILE_DOOR;
  map.setTile(doorX, doorTop, doorTile);
  map.setTile(doorX, doorTop + 1, doorTile);
  if (breakableDoor) {
    for (let y = 1; y < h - 1; y++) {
      if (y === doorTop || y === doorTop + 1) continue;
      if (ladderTx >= 0 && doorX === ladderTx) continue;
      map.setTile(doorX, y, TILE_SOLID);
    }
  } else {
    for (let y = 1; y < doorTop; y++) {
      if (ladderTx >= 0 && doorX === ladderTx) continue;
      map.setTile(doorX, y, TILE_SOLID);
    }
  }
}

function sealUnusedHorizontalEdges(map, conn){
  const w = map.getWidth();
  const h = map.getHeight();
  if (!conn.doorWest) sealSecretColumn(map, 1, -1, h);
  if (!conn.doorEast) sealSecretColumn(map, w - 2, -1, h);
}

function sealSecretColumn(map, edgeX, ladderTx, h){
  for (let y = 1; y < h - 1; y++) {
    if (ladderTx >= 0 && edgeX === ladderTx) continue;
    map.setTile(edgeX, y, TILE_SOLID);
  }
}

function alignLeftDoorTopY(gen, doorX, neighborRightDoorTopY){
  if (doorX < 0 || neighborRightDoorTopY < 0) return gen;
  const map = gen.map;
  const doorTop = clamp(neighborRightDoorTopY, 1, map.getHeight() - 4);
  carveHorizontalFace(map, doorX, doorTop, false, gen.ladderColumnTx, true);
  return { ...gen, leftDoorTileX: doorX, leftDoorTopTileY: doorTop };
}

function alignRightDoorTopY(gen, doorX, neighborLeftDoorTopY){
  if (doorX < 0 || neighborLeftDoorTopY < 0) return gen;
  const map = gen.map;
  const doorTop = clamp(neighborLeftDoorTopY, 1, map.getHeight() - 4);
  carveHorizontalFace(map, doorX, doorTop, true, gen.ladderColumnTx, true);
  return { ...gen, rightDoorTileX: doorX, rightDoorTopTileY: doorTop };
}

function secretRoomMapBuildFinish(gen, kind, conn, secretSeams, neighborFaces){
  let room = gen;
  const map = room.map;
  const ladderTx = room.ladderColumnTx;
  if (neighborFaces?.finishEastFace && conn.doorEast && room.rightDoorTileX >= 0) {
    carveHorizontalFace(map, room.rightDoorTileX, room.rightDoorTopTileY, true, ladderTx, true);
  }
  if (neighborFaces?.finishWestFace && conn.doorWest && room.leftDoorTileX >= 0) {
    carveHorizontalFace(map, room.leftDoorTileX, room.leftDoorTopTileY, false, ladderTx, true);
  }
  if (secretSeams?.edges?.length) {
    for (const edge of secretSeams.edges) {
      const doorX = edge.secretEastFace
        ? conn.doorEast
          ? room.rightDoorTileX
          : map.getWidth() - 2
        : conn.doorWest
          ? room.leftDoorTileX
          : 1;
      const doorTop = clamp(edge.neighborDoorTopY, 1, map.getHeight() - 4);
      carveHorizontalFace(map, doorX, doorTop, edge.secretEastFace, -1, true);
      room = edge.secretEastFace
        ? { ...room, rightDoorTileX: doorX, rightDoorTopTileY: doorTop }
        : { ...room, leftDoorTileX: doorX, leftDoorTopTileY: doorTop };
    }
    if (kind === RoomKind.SECRET) sealUnusedHorizontalEdges(map, conn);
  }
  return room;
}

function makeGeneratedRoom(map, meta){
  return {
    map,
    leftDoorTileX: meta.leftDoorTileX ?? -1,
    leftDoorTopTileY: meta.leftDoorTopTileY ?? -1,
    rightDoorTileX: meta.rightDoorTileX ?? -1,
    rightDoorTopTileY: meta.rightDoorTopTileY ?? -1,
    ladderColumnTx: meta.ladderColumnTx ?? -1,
    contentSeed: meta.contentSeed ?? 0,
    kind: meta.kind ?? RoomKind.NORMAL,
    enemyCount: meta.enemyCount ?? 2,
  };
}

function rollRoomEnemyCount(kind, contentSeed){
  if (kind === RoomKind.BOSS || kind === RoomKind.SUPER_SECRET) return 0;
  if (kind === RoomKind.SECRET) {
    const rng = javaRandom(Number(BigInt(contentSeed) ^ 0x5ec7e701n));
    return rng.nextDouble() < SECRET_ROOM_ENEMY_CHANCE ? 2 : 0;
  }
  return 2;
}

class SecretSeam {
  constructor(kind, roomA, roomB, ladderTx, cells){
    this.kind = kind;
    this.roomA = roomA;
    this.roomB = roomB;
    this.ladderTx = ladderTx;
    this.cells = cells;
    this.breakablesRemaining = cells.filter((c) => c.role === SEAM_ROLE_BREAKABLE).length;
    this.done = false;
  }

  linksRooms(a, b){
    return (this.roomA === a && this.roomB === b) || (this.roomA === b && this.roomB === a);
  }

  isDone(){
    return this.done || this.breakablesRemaining <= 0;
  }

  isHiddenBreakable(roomId, tx, ty){
    if (this.isDone()) return false;
    return this.cells.some(
      (c) => c.role === SEAM_ROLE_BREAKABLE && !c.cleared && c.roomId === roomId && c.tx === tx && c.ty === ty
    );
  }

  markBreakableCleared(rooms, roomId, tx, ty){
    for (const c of this.cells) {
      if (c.role !== SEAM_ROLE_BREAKABLE || c.cleared || c.roomId !== roomId || c.tx !== tx || c.ty !== ty) continue;
      c.cleared = true;
      this.breakablesRemaining--;
      rooms[roomId].map.setTile(tx, ty, c.restore);
      return true;
    }
    return false;
  }

  openRoomFaceInstant(rooms, roomId){
    for (const c of this.cells) {
      if (c.role !== SEAM_ROLE_BREAKABLE || c.cleared || c.roomId !== roomId) continue;
      c.cleared = true;
      this.breakablesRemaining--;
      rooms[roomId].map.setTile(c.tx, c.ty, c.restore);
    }
    if (this.kind === SEAM_KIND_VERTICAL) {
      const g = rooms[roomId];
      const L = clampLadderColumn(g.map.getWidth(), this.ladderTx);
      if (L >= 0) {
        const t0 = g.map.tileAt(L, 0);
        if (t0 !== TILE_DOOR && t0 !== TILE_BREAKABLE) g.map.setTile(L, 0, TILE_LADDER);
      }
    }
    if (this.breakablesRemaining <= 0) this.done = true;
  }

  seamMatchesTraverseDir(fromRoom, toRoom, dir){
    if (this.kind === SEAM_KIND_HORIZONTAL) {
      if (dir === "east") return this.roomA === fromRoom && this.roomB === toRoom;
      if (dir === "west") return this.roomA === toRoom && this.roomB === fromRoom;
    } else {
      if (dir === "south") return this.roomA === fromRoom && this.roomB === toRoom;
      if (dir === "north") return this.roomA === toRoom && this.roomB === fromRoom;
    }
    return false;
  }
}

function northRoomSouthSealY(map, ladderTx){
  const mouth = resolvedLadderRunwayRow(map, ladderTx, true);
  return Math.max(1, mouth - 1);
}

function placeSecretEntranceSeams(layout, rooms){
  const out = [];
  const horizontalEdges = new Set();
  const verticalEdges = new Set();
  const n = layout.roomCount();
  for (let id = 0; id < n; id++) {
    if (!isSecretKind(layout.room(id).kind)) continue;
    const e = layout.neighborEast(id);
    if (e >= 0) {
      const ek = `${id}|${e}`;
      if (!horizontalEdges.has(ek)) {
        horizontalEdges.add(ek);
        tryAddHorizontalSeam(layout, rooms, out, id, e);
      }
    }
    const w = layout.neighborWest(id);
    if (w >= 0) {
      const ek = `${w}|${id}`;
      if (!horizontalEdges.has(ek)) {
        horizontalEdges.add(ek);
        tryAddHorizontalSeam(layout, rooms, out, w, id);
      }
    }
    const north = layout.neighborNorth(id);
    if (north >= 0) {
      const vk = `${north}|${id}`;
      if (!verticalEdges.has(vk)) {
        verticalEdges.add(vk);
        tryAddVerticalSeam(layout, rooms, out, north, id);
      }
    }
    const south = layout.neighborSouth(id);
    if (south >= 0) {
      const vk = `${id}|${south}`;
      if (!verticalEdges.has(vk)) {
        verticalEdges.add(vk);
        tryAddVerticalSeam(layout, rooms, out, id, south);
      }
    }
  }
  return out;
}

function tryAddHorizontalSeam(layout, rooms, out, westRoomId, eastRoomId){
  let gW = rooms[westRoomId];
  let gE = rooms[eastRoomId];
  if (!gW || !gE) return;
  let rx = gW.rightDoorTileX;
  let ry = gW.rightDoorTopTileY;
  let lx = gE.leftDoorTileX;
  let ly = gE.leftDoorTopTileY;
  if (rx < 0 || ry < 0 || lx < 0 || ly < 0) return;
  if (ry !== ly) {
    const westSecret = isSecretKind(layout.room(westRoomId).kind);
    const eastSecret = isSecretKind(layout.room(eastRoomId).kind);
    if (westSecret && !eastSecret) {
      rooms[eastRoomId] = alignLeftDoorTopY(gE, lx, ry);
      gE = rooms[eastRoomId];
      ly = gE.leftDoorTopTileY;
    } else if (eastSecret && !westSecret) {
      rooms[westRoomId] = alignRightDoorTopY(gW, rx, ly);
      gW = rooms[westRoomId];
      ry = gW.rightDoorTopTileY;
    } else {
      rooms[eastRoomId] = alignLeftDoorTopY(gE, lx, ry);
      gE = rooms[eastRoomId];
      ly = gE.leftDoorTopTileY;
    }
  }
  if (ry !== ly) return;
  const cells = [];
  const addBreakable = (roomId, tx, ty, restore, map) => {
    cells.push({ roomId, tx, ty, restore, role: SEAM_ROLE_BREAKABLE, cleared: false });
    map.setTile(tx, ty, TILE_BREAKABLE);
  };
  const addBuffer = (roomId, tx, ty, role) => {
    cells.push({ roomId, tx, ty, restore: TILE_SOLID, role, cleared: false });
  };
  for (let dy = 0; dy <= 1; dy++) {
    addBreakable(westRoomId, rx, ry + dy, TILE_DOOR, gW.map);
    addBreakable(eastRoomId, lx, ly + dy, TILE_DOOR, gE.map);
  }
  const hW = gW.map.getHeight();
  const hE = gE.map.getHeight();
  for (let y = 1; y < hW - 1; y++) addBuffer(westRoomId, Math.min(gW.map.getWidth() - 1, rx + 1), y, SEAM_ROLE_BUFFER_EAST);
  for (let y = 1; y < hE - 1; y++) addBuffer(eastRoomId, Math.max(0, lx - 1), y, SEAM_ROLE_BUFFER_WEST);
  out.push(new SecretSeam(SEAM_KIND_HORIZONTAL, westRoomId, eastRoomId, -1, cells));
}

function tryAddVerticalSeam(layout, rooms, out, northRoomId, southRoomId){
  const northNode = layout.room(northRoomId);
  const southNode = layout.room(southRoomId);
  if (!northNode.ladderSouth || !southNode.ladderNorth) return;
  const gN = rooms[northRoomId];
  const gS = rooms[southRoomId];
  if (!gN || !gS) return;
  let layoutL = northNode.ladderColumnTx;
  if (layoutL < 0) layoutL = southNode.ladderColumnTx;
  if (layoutL < 0) return;
  const lN = clampLadderColumn(gN.map.getWidth(), layoutL);
  const lS = clampLadderColumn(gS.map.getWidth(), layoutL);
  const northY = northRoomSouthSealY(gN.map, lN);
  const southY = 1;
  const cells = [];
  const addBreakable = (roomId, tx, y, restore, map) => {
    if (y < 1 || y >= map.getHeight() - 1) return false;
    cells.push({ roomId, tx, ty: y, restore, role: SEAM_ROLE_BREAKABLE, cleared: false });
    map.setTile(tx, y, TILE_BREAKABLE);
    return true;
  };
  if (!addBreakable(northRoomId, lN, northY, TILE_LADDER, gN.map)) return;
  if (!addBreakable(southRoomId, lS, southY, TILE_LADDER, gS.map)) return;
  const hN = gN.map.getHeight();
  for (let y = 1; y < hN - 1; y++) {
    if (y === northY) continue;
    cells.push({ roomId: northRoomId, tx: lN, ty: y, restore: TILE_SOLID, role: SEAM_ROLE_BUFFER, cleared: false });
  }
  if (gS.map.tileAt(lS, 0) !== TILE_DOOR && gS.map.tileAt(lS, 0) !== TILE_BREAKABLE) {
    gS.map.setTile(lS, 0, TILE_EMPTY);
  }
  out.push(new SecretSeam(SEAM_KIND_VERTICAL, northRoomId, southRoomId, layoutL, cells));
}

function findSeamForTransition(seams, fromRoom, toRoom, dir){
  if (!seams) return null;
  for (const seam of seams) {
    if (seam.isDone() || !seam.linksRooms(fromRoom, toRoom)) continue;
    if (seam.seamMatchesTraverseDir(fromRoom, toRoom, dir)) return seam;
  }
  return null;
}

function openEnteredFaceForTransition(layout, rooms, seams, fromRoom, toRoom, dir){
  const seam = findSeamForTransition(seams, fromRoom, toRoom, dir);
  if (seam && !seam.isDone()) seam.openRoomFaceInstant(rooms, toRoom);
}

function buildDungeonContent(layout){
  const n = layout.roomCount();
  const plannedW = plannedRoomWidths(layout);
  const plannedH = plannedRoomHeights(layout);
  const rooms = new Array(n);
  for (let i = 0; i < n; i++) {
    const kind = layout.room(i).kind;
    if (isSecretKind(kind)) continue;
    rooms[i] = generateRoomContent(layout.room(i), plannedW[i], plannedH[i], {
      neighborFaces: neighborSecretFaces(layout, i),
    });
  }
  for (let i = 0; i < n; i++) {
    const kind = layout.room(i).kind;
    if (!isSecretKind(kind)) continue;
    rooms[i] = generateRoomContent(layout.room(i), plannedW[i], plannedH[i], {
      secretSeams: secretRoomSeams(layout, i, rooms),
    });
  }
  const seams = placeSecretEntranceSeams(layout, rooms);
  return { rooms, seams };
}

/** Procedural room generator (port of Java RoomGenerator core terrain pass). */
function generateRoomContent(node, plannedW, plannedH, secretFinish = null){
  const kind = node.kind;
  const w = plannedW;
  const h = plannedH;
  const seed = Number(BigInt(node.contentSeed) ^ 0x9e3779b97f4a7c15n);
  const rng = javaRandom(seed);
  const conn = {
    doorWest: node.doorWest,
    doorEast: node.doorEast,
    ladderNorth: node.ladderNorth,
    ladderSouth: node.ladderSouth,
    ladderColumnTx: node.ladderColumnTx,
  };
  let dungeonLadderTx = conn.ladderColumnTx;
  if (dungeonLadderTx >= 0) dungeonLadderTx = clamp(dungeonLadderTx, 3, w - 4);
  const maxReach = maxVerticalReachTilesForGridY(node.gridY);
  const noise = valueNoise1D(seed, w, 8);

  const groundY = new Array(w);
  const base = Math.min(h - 2, Math.round(h * 0.75));
  const minY = Math.max(4, h - 12);
  const maxY = h - 2;

  if (kind === RoomKind.START) {
    const flatY = clamp(base, minY, maxY);
    groundY.fill(flatY);
  } else {
    let prev = clamp(Math.round(base - noise[0] * 4), minY, maxY);
    groundY[0] = prev;
    let flatRun = 0;
    for (let x = 1; x < w; x++) {
      let target = clamp(Math.round(base - noise[x] * 4), minY, maxY);
      let dy = target - prev;
      if (dy > 1) target = prev + 1;
      if (dy < -1) target = prev - 1;
      const bigUp = target < prev - 1 ? 1 : 0;
      if (bigUp === 1 && flatRun < 2) target = prev;
      if (target === prev) flatRun++;
      else flatRun = 0;
      prev = target;
      groundY[x] = prev;
    }
  }

  const grid = Array.from({ length: h }, () => new Array(w).fill("."));
  for (let x = 0; x < w; x++) {
    grid[0][x] = "#";
    grid[h - 1][x] = "#";
  }
  for (let y = 0; y < h; y++) {
    grid[y][0] = "#";
    grid[y][w - 1] = "#";
  }

  const entryPadStartX = kind === RoomKind.SECRET && !conn.doorWest ? 2 : 1;
  const entryX = Math.min(entryPadStartX + 1, w - 2);
  const entryY = groundY[entryX];
  const entryPadEndX = Math.min(entryPadStartX + 5, w - 2);
  for (let x = entryPadStartX; x <= entryPadEndX; x++) {
    const gy = entryY;
    for (let y = 1; y < h - 1; y++) grid[y][x] = ".";
    for (let y = gy; y < h - 1; y++) grid[y][x] = "#";
    groundY[x] = entryY;
  }

  if (kind === RoomKind.SHOP || kind === RoomKind.SUPER_SECRET) {
    groundY.fill(entryY);
  } else {
    const rampX = entryPadEndX + 1;
    if (rampX < w - 2) {
      const dy = groundY[rampX] - entryY;
      if (dy > maxReach) {
        for (let i = 1; i <= maxReach; i++) {
          const py = Math.max(2, entryY + i);
          if (py >= 2 && py < h - 1) grid[py][rampX] = "-";
        }
        groundY[rampX] = entryY + maxReach;
      } else if (dy < -maxReach) {
        groundY[rampX] = entryY - maxReach;
        for (let y = groundY[rampX]; y <= entryY; y++) {
          if (y >= 1 && y < h - 1) grid[y][rampX] = "H";
        }
      }
    }
  }

  const leftDoorX = 1;
  const rightDoorX = w - 2;
  if (conn.doorWest) {
    const leftAdjX = 2;
    groundY[leftDoorX] = groundY[Math.min(leftAdjX, w - 2)];
    groundY[Math.min(leftAdjX, w - 2)] = groundY[leftDoorX];
    flattenGroundRun(groundY, 1, Math.min(3, w - 2));
  }
  if (conn.doorEast) {
    const rightAdjX = w - 3;
    groundY[rightDoorX] = groundY[Math.max(1, Math.min(rightAdjX, w - 2))];
    groundY[Math.max(1, Math.min(rightAdjX, w - 2))] = groundY[rightDoorX];
    const eastHi = w - 2;
    const eastLo = Math.max(7, eastHi - 3);
    if (eastLo <= eastHi) flattenGroundRun(groundY, eastLo, eastHi);
  }

  const leftGroundY = conn.doorWest ? groundY[Math.min(leftDoorX, w - 2)] : -1;
  const rightGroundY = conn.doorEast ? groundY[Math.min(rightDoorX, w - 2)] : -1;
  const leftDoorTopY = conn.doorWest ? clamp(leftGroundY - 2, 1, h - 3) : -1;
  const rightDoorTopY = conn.doorEast ? clamp(rightGroundY - 2, 1, h - 3) : -1;

  if (secretFinish?.secretSeams) {
    alignAsciiGroundYToSeams(groundY, w, h, secretFinish.secretSeams);
  }

  if (
    dungeonLadderTx >= 3 &&
    dungeonLadderTx < w - 3 &&
    (conn.ladderNorth || conn.ladderSouth) &&
    !usesFlatLadderFloorKind(kind)
  ) {
    const L = dungeonLadderTx;
    const x0 = Math.max(7, L - 4);
    let baseFloor = groundY[L];
    for (let x = x0; x <= Math.min(L + 1, w - 3); x++) baseFloor = Math.max(baseFloor, groundY[x]);
    for (let x = x0; x <= Math.min(L + 1, w - 3); x++) groundY[x] = baseFloor;
  }

  if (kind !== RoomKind.SECRET && kind !== RoomKind.SUPER_SECRET && kind !== RoomKind.SHOP) {
    enforceMaxWalkableGroundYStep(groundY, maxReach);
  }

  for (let x = 1; x < w - 1; x++) {
    const gy = clamp(groundY[x], 1, h - 2);
    for (let y = 1; y < h - 1; y++) grid[y][x] = ".";
    for (let y = gy; y < h - 1; y++) grid[y][x] = "#";
  }

  if (conn.doorWest) {
    grid[leftDoorTopY][leftDoorX] = "D";
    grid[leftDoorTopY + 1][leftDoorX] = "D";
  }
  if (conn.doorEast) {
    grid[rightDoorTopY][rightDoorX] = "D";
    grid[rightDoorTopY + 1][rightDoorX] = "D";
  }

  const placeRandomLadders = kind === RoomKind.NORMAL;
  const placeRandomPlatforms = kind === RoomKind.NORMAL || kind === RoomKind.BOSS;
  const dungeonVerticalLink =
    dungeonLadderTx >= 0 && (conn.ladderNorth || conn.ladderSouth);

  for (let x = 3; x < w - 3; x++) {
    if (x === leftDoorX || x === rightDoorX) continue;
    if (dungeonLadderTx >= 0 && x === dungeonLadderTx) continue;
    if (placeRandomLadders && rng.nextInt(10) === 0) {
      const gy = clamp(groundY[x], 2, h - 2);
      const ladderH = 3 + rng.nextInt(4);
      for (let y = Math.max(1, gy - ladderH); y <= gy - 1; y++) {
        if (grid[y][x] === ".") grid[y][x] = "H";
      }
    }
    if (placeRandomPlatforms && rng.nextInt(7) === 0) {
      const gy = clamp(groundY[x], 4, h - 2);
      const py = clamp(gy - (3 + rng.nextInt(5)), 2, h - 4);
      if (py >= 2 && py < gy - 1) {
        const len = rng.nextInt(5) === 0 ? 2 : 3 + rng.nextInt(3);
        const sx = clamp(x - rng.nextInt(2), 2, w - 3);
        for (let dx = 0; dx < len; dx++) {
          const tx = sx + dx;
          if (tx <= 1 || tx >= w - 2) continue;
          if (dungeonLadderTx >= 0 && tx === dungeonLadderTx) continue;
          if (grid[py][tx] === ".") grid[py][tx] = "-";
        }
      }
    }
  }

  if (dungeonLadderTx >= 3 && dungeonLadderTx < w - 3 && dungeonVerticalLink) {
    const L = dungeonLadderTx;
    const mouthRow = resolvedLadderRunwayRowOnGrid(grid, w, h, groundY, L, conn.ladderSouth);
    let y0;
    const y1 = mouthRow - 1;
    if (conn.ladderNorth && conn.ladderSouth) y0 = 1;
    else if (conn.ladderSouth) y0 = Math.max(1, mouthRow - 14);
    else y0 = 1;
    for (let y = y0; y <= y1; y++) {
      if (y < 1 || y >= h - 1) continue;
      if (grid[y][L] === "D") continue;
      grid[y][L] = "H";
    }
    if (conn.ladderSouth) {
      for (let y = mouthRow + 1; y < h - 1; y++) {
        if (grid[y][L] === "D") continue;
        grid[y][L] = "H";
      }
      if (grid[h - 1][L] !== "D") grid[h - 1][L] = "H";
    } else {
      if (grid[mouthRow][L] !== "D") grid[mouthRow][L] = "#";
      for (let y = mouthRow + 1; y < h - 1; y++) {
        if (grid[y][L] === "D") continue;
        grid[y][L] = "#";
      }
    }
    if (grid[0][L] !== "D") grid[0][L] = conn.ladderNorth ? "." : "#";
    finalizeDungeonLadderMouthOnGrid(grid, w, h, L, mouthRow, conn);
  }

  if (dungeonVerticalLink) {
    const mouthRow = resolvedLadderRunwayRowOnGrid(
      grid,
      w,
      h,
      groundY,
      dungeonLadderTx,
      conn.ladderSouth
    );
    stripSpuriousLaddersFromGrid(grid, w, h, dungeonLadderTx, groundY);
    if (dungeonLadderTx >= 3 && dungeonLadderTx < w - 3) {
      finalizeDungeonLadderMouthOnGrid(grid, w, h, dungeonLadderTx, mouthRow, conn);
    }
  } else if (kind === RoomKind.NORMAL || kind === RoomKind.BOSS) {
    stripSpuriousLaddersFromGrid(grid, w, h, -1, groundY);
  }

  if (kind === RoomKind.BOSS) {
    const bossGy = groundY[Math.floor(w / 2)];
    for (let x = 4; x < w - 4; x += 5) {
      const py = bossGy - 3;
      if (py >= 1 && py < h - 1) grid[py][x] = "#";
    }
  }

  let map = TileMap.fromAscii(gridToAsciiRows(grid));
  let gen = makeGeneratedRoom(map, {
    leftDoorTileX: conn.doorWest ? leftDoorX : -1,
    leftDoorTopTileY: leftDoorTopY,
    rightDoorTileX: conn.doorEast ? rightDoorX : -1,
    rightDoorTopTileY: rightDoorTopY,
    ladderColumnTx: dungeonLadderTx,
    contentSeed: node.contentSeed,
    kind,
    enemyCount: rollRoomEnemyCount(kind, node.contentSeed),
  });
  if (secretFinish?.secretSeams || secretFinish?.neighborFaces) {
    gen = secretRoomMapBuildFinish(
      gen,
      kind,
      conn,
      secretFinish.secretSeams ?? null,
      secretFinish.neighborFaces ?? null
    );
  }
  return gen;
}

function generateRoom(node){
  const largeArena = node.kind === RoomKind.NORMAL || node.kind === RoomKind.SECRET;
  return generateRoomContent(
    node,
    largeArena ? WIDE_W : SCREEN_W,
    largeArena ? WIDE_H : SCREEN_H
  ).map;
}

function playFloorRowAt(map, tx){
  const w = map.getWidth();
  const h = map.getHeight();
  const col = clamp(tx, 1, w - 2);
  for (let y = h - 2; y >= 1; y--) {
    if (map.isSolidTile(col, y) || map.isPlatformTile(col, y)) return y;
  }
  return h - 2;
}

function resolvedLadderRunwayRow(map, ladderTx, ladderSouth){
  const w = map.getWidth();
  const l = clamp(ladderTx, 1, w - 2);
  const left = playFloorRowAt(map, l - 1);
  const right = playFloorRowAt(map, l + 1);
  if (left !== right) return ladderSouth ? Math.max(left, right) : Math.min(left, right);
  return left;
}

function roomSpawnTx(node, map, fromWest, fromEast){
  if (fromWest && node.doorWest) return 2;
  if (fromEast && node.doorEast) return map.getWidth() - 3;
  return Math.floor(map.getWidth() / 2);
}

function ladderSpawnFromNorth(node, map){
  const L = roomLadderColumnTx(node, map);
  if (L < 0) return null;
  return { x: L * TILE_SIZE + TILE_SIZE / 2 - 5, y: 3 * TILE_SIZE - 32 };
}

function ladderSpawnFromSouth(node, map){
  const L = roomLadderColumnTx(node, map);
  if (L < 0) return null;
  return { x: L * TILE_SIZE + TILE_SIZE / 2 - 5, y: map.getHeight() * TILE_SIZE - 32 };
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

  getRedMax(){
    return Math.floor(this.redMax + 1e-9);
  }

  getRedCurrent(){
    return Math.floor(this.redCurrent + 1e-9);
  }

  isAlive(){
    return this.redCurrent + this.soul > 1e-9;
  }

  isDead(){
    return !this.isAlive();
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

function spawnAtFloor(map, spawnTx, bodyHeight = PLAYER_STAND_H){
  const groundTop = map.groundTopWorldYAtColumn(spawnTx);
  return { x: spawnTx * TILE_SIZE, y: groundTop - bodyHeight };
}

const ENEMY_CRAWLER_HITBOX_H = 12;
const ENEMY_CRAWLER_SPRITE_W = 16;
const ENEMY_CRAWLER_SPRITE_H = 16;

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

  applyContactKnockback(horizontalSign){
    this.vx = horizontalSign * 74;
    this.vy = -98;
    this.onGround = false;
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
  h = ENEMY_CRAWLER_HITBOX_H;

  feetY(){
    return this.y + this.h;
  }

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
    if (this.dead || !this.health.isAlive() || this.hurtTint > 0) return;

    const pr = playerHurtRect(player.x, player.y, player.h());
    const er = crawlerContactRect(this.x, this.y);
    if (!rectsOverlapSlack(pr, er)) return;

    if (player.health.tryDamage(1, 1.125)) {
      player.hurtTint = 0.35;
      const pcx = player.x + player.w() * 0.5;
      const ecx = this.x + 4;
      const sign = pcx < ecx ? -1 : 1;
      player.applyContactKnockback(sign);
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
  for (let i = 0; i < count; i++) {
    const tx = 4 + ((seed + i * 7) % Math.max(1, map.getWidth() - 8));
    const spawn = spawnAtFloor(map, tx, ENEMY_CRAWLER_HITBOX_H);
    enemies.push(new CrawlerEnemy(spawn.x, spawn.y));
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
    const res = await fetch(new URL("data/items.json", assetBase).href);
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
  inflight = new Map();
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
      "sprites/sword attack.png",
      "sprites/crawler.png",
      "sprites/UI health.png",
      "tiles/forest tileset.png",
    ];
    const optional = [
      "sprites/UI key.png",
      "sprites/UI coin.png",
      "tiles/underground tileset.png",
      "tiles/la sheet.png",
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
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const loadPromise = this._fetchImage(relPath);
    this.inflight.set(key, loadPromise);
    try {
      const img = await loadPromise;
      this.images.set(key, img);
      this.loaded++;
      return img;
    } finally {
      this.inflight.delete(key);
    }
  }

  async _fetchImage(relPath){
    const url = resolveAssetUrl(this.assetBase, relPath);
    const el = new Image();
    el.decoding = "async";

    const waitLoaded = () =>
      new Promise((resolve, reject) => {
        if (el.complete && el.naturalWidth > 0) {
          resolve();
          return;
        }
        el.onload = () => resolve();
        el.onerror = () => reject(new Error(`Failed to load ${url}`));
      });

    el.src = url;
    try {
      await waitLoaded();
      if (el.naturalWidth > 0) return el;
    } catch (_directErr) {
      // Direct src can fail on some hosts; retry via blob (do not revoke — keeps canvas drawable).
    }

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    el.src = blobUrl;
    await waitLoaded();
    if (el.naturalWidth <= 0) throw new Error(`Failed to decode ${url}`);
    return el;
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
  gameOver = false;

  constructor(opts) {
    this.initRun(opts.seed);
  }

  initRun(seed){
    this.seed = seed >>> 0;
    this.gameOver = false;
    this.transitionFade = 0;
    this.transitionDir = null;
    this.currentRoomId = 0;
    this.layout = DungeonLayout.generate(this.seed, 12, 24);
    const built = buildDungeonContent(this.layout);
    this.cachedRooms = built.rooms;
    this.secretEntranceSeams = built.seams;
    const n = this.layout.roomCount();
    this.roomVisited = new Array(n).fill(false);
    this.minimapAdjacentSeen = new Array(n).fill(false);
    this.roomVisited[0] = true;
    this.revealMinimapAdjacentNeighbors(0);
    this.loadRoom(0);
    this.player = new Player();
    const spawn = spawnAtFloor(this.map, roomSpawnTx(this.layout.room(0), this.map, false, false));
    this.player.resetAt(spawn.x, spawn.y);
    this.camera.reset(this.cameraAnchorX(), this.cameraAnchorY());
  }

  loadRoom(roomId){
    const gen = this.cachedRooms[roomId];
    this.map = gen.map;
    this.enemies = spawnEnemiesForRoom(this.map, gen.contentSeed, gen.enemyCount);
  }

  currentGeneratedRoom(){
    return this.cachedRooms[this.currentRoomId];
  }

  isHiddenShellBreakable(tx, ty){
    if (!this.secretEntranceSeams) return false;
    for (const seam of this.secretEntranceSeams) {
      if (seam.isHiddenBreakable(this.currentRoomId, tx, ty)) return true;
    }
    return false;
  }

  tryStrikeSeamBreakables(hit){
    if (!hit || !this.secretEntranceSeams) return;
    const x0 = Math.floor(hit.x / TILE_SIZE);
    const x1 = Math.floor((hit.x + hit.w) / TILE_SIZE);
    const y0 = Math.floor(hit.y / TILE_SIZE);
    const y1 = Math.floor((hit.y + hit.h) / TILE_SIZE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (!this.map.isBreakableTile(tx, ty)) continue;
        for (const seam of this.secretEntranceSeams) {
          if (seam.markBreakableCleared(this.cachedRooms, this.currentRoomId, tx, ty)) break;
        }
      }
    }
  }

  seamBlocksTransition(fromRoom, toRoom, dir){
    const seam = findSeamForTransition(this.secretEntranceSeams, fromRoom, toRoom, dir);
    return seam != null && !seam.isDone();
  }

  revealMinimapAdjacentNeighbors(roomId){
    this.revealMinimapAdjacentRoom(this.layout.neighborWest(roomId));
    this.revealMinimapAdjacentRoom(this.layout.neighborEast(roomId));
    this.revealMinimapAdjacentRoom(this.layout.neighborNorth(roomId));
    this.revealMinimapAdjacentRoom(this.layout.neighborSouth(roomId));
  }

  revealMinimapAdjacentRoom(neighborId){
    if (neighborId < 0 || neighborId >= this.minimapAdjacentSeen.length) return;
    const kind = this.layout.room(neighborId).kind;
    if (kind === RoomKind.SECRET || kind === RoomKind.SUPER_SECRET) return;
    this.minimapAdjacentSeen[neighborId] = true;
  }

  restartRun(seed){
    this.initRun(seed);
  }

  getSeed(){
    return this.seed;
  }

  update(dt, input){
    if (this.transitionFade > 0) {
      this.transitionFade = Math.max(0, this.transitionFade - dt * 2);
      return;
    }

    if (!this.gameOver && this.player.health.isDead()) {
      this.gameOver = true;
      input?.clearHardwareState?.();
      return;
    }

    if (this.gameOver) {
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
      this.tryStrikeSeamBreakables(hit);
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

    // Room transitions (doors + ladder shafts)
    this.tryDoorTransition(input);
    this.tryLadderTransition(input);

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
    if (!anyPressed(input, Keys.up)) return;
    if (!this.player.onGround) return;

    const pr = {
      x: this.player.x,
      y: this.player.y,
      w: this.player.w(),
      h: this.player.h(),
    };
    const x0 = Math.floor(pr.x / TILE_SIZE);
    const x1 = Math.floor((pr.x + pr.w - 1e-6) / TILE_SIZE);
    const y0 = Math.floor(pr.y / TILE_SIZE);
    const y1 = Math.floor((pr.y + pr.h - 1e-6) / TILE_SIZE);

    let touchedLeft = false;
    let touchedRight = false;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (!this.map.isDoorTile(tx, ty)) continue;
        if (tx <= 1) touchedLeft = true;
        if (tx >= this.map.getWidth() - 2) touchedRight = true;
      }
    }

    const node = this.layout.room(this.currentRoomId);

    if (touchedRight && node.doorEast) {
      const east = this.layout.neighborEast(this.currentRoomId);
      if (east >= 0 && !this.seamBlocksTransition(this.currentRoomId, east, "east")) {
        this.beginTransition(east, "east", input);
      }
    } else if (touchedLeft && node.doorWest) {
      const west = this.layout.neighborWest(this.currentRoomId);
      if (west >= 0 && !this.seamBlocksTransition(this.currentRoomId, west, "west")) {
        this.beginTransition(west, "west", input);
      }
    }
  }

  tryLadderTransition(input){
    const node = this.layout.room(this.currentRoomId);
    const L = roomLadderColumnTx(node, this.map);
    if (L < 0) return;
    if (!this.playerOverlapsLadderColumn(L)) return;

    const wantDown = anyDown(input, Keys.down);
    const wantUp = anyDown(input, Keys.up);
    if (!wantDown && !wantUp) return;

    if (wantDown && node.ladderSouth && this.playerNearRoomSouthEdge()) {
      if (!this.southLadderMouthAllowsTransition(L)) return;
      const south = this.layout.neighborSouth(this.currentRoomId);
      if (south >= 0 && !this.seamBlocksTransition(this.currentRoomId, south, "south")) {
        this.beginTransition(south, "south", input);
      }
      return;
    }
    if (wantUp && node.ladderNorth && this.playerNearRoomNorthEdge()) {
      if (!this.northLadderSeamOpenAtTop(L)) return;
      const north = this.layout.neighborNorth(this.currentRoomId);
      if (north >= 0 && !this.seamBlocksTransition(this.currentRoomId, north, "north")) {
        this.beginTransition(north, "north", input);
      }
    }
  }

  playerOverlapsLadderColumn(ladderTx){
    const left = ladderTx * TILE_SIZE;
    const right = (ladderTx + 1) * TILE_SIZE;
    const px1 = this.player.x;
    const px2 = this.player.x + this.player.w();
    return px2 > left && px1 < right;
  }

  playerNearRoomSouthEdge(){
    return this.player.feetY() >= this.map.getHeight() * TILE_SIZE - TILE_SIZE * 2;
  }

  playerNearRoomNorthEdge(){
    return this.player.y <= TILE_SIZE * 2;
  }

  southLadderMouthAllowsTransition(ladderTx){
    const runwayRow = resolvedLadderRunwayRow(this.map, ladderTx, true);
    const h = this.map.getHeight();
    if (runwayRow < 1 || runwayRow >= h - 1) return false;
    const t = this.map.tileAt(ladderTx, runwayRow);
    return (
      t !== TILE_SOLID &&
      t !== TILE_BREAKABLE &&
      t !== TILE_KEYBLOCK &&
      t !== TILE_KEYBLOCK_CONNECTOR
    );
  }

  northLadderSeamOpenAtTop(ladderTx){
    const t = this.map.tileAt(ladderTx, 0);
    return t === TILE_EMPTY || t === TILE_LADDER;
  }

  beginTransition(roomId, dir, input) {
    const fromRoom = this.currentRoomId;
    this.currentRoomId = roomId;
    if (roomId >= 0 && roomId < this.roomVisited.length) {
      this.roomVisited[roomId] = true;
    }
    this.revealMinimapAdjacentNeighbors(roomId);
    openEnteredFaceForTransition(
      this.layout,
      this.cachedRooms,
      this.secretEntranceSeams,
      fromRoom,
      roomId,
      dir
    );
    this.loadRoom(roomId);
    const node = this.layout.room(roomId);
    const gen = this.currentGeneratedRoom();

    let spawn;
    if (dir === "south") {
      const p = ladderSpawnFromSouth(node, this.map);
      spawn = p ? { x: p.x, y: p.y } : spawnAtFloor(this.map, roomSpawnTx(node, this.map, false, false));
      this.player.resetAt(spawn.x, spawn.y);
      this.player.onGround = false;
    } else if (dir === "north") {
      const p = ladderSpawnFromNorth(node, this.map);
      spawn = p ? { x: p.x, y: p.y } : spawnAtFloor(this.map, roomSpawnTx(node, this.map, false, false));
      this.player.resetAt(spawn.x, spawn.y);
      this.player.onGround = false;
    } else if (dir === "west" && gen.leftDoorTileX >= 0) {
      spawn = {
        x: (gen.leftDoorTileX + 1) * TILE_SIZE,
        y: (gen.leftDoorTopTileY + 2) * TILE_SIZE - 32,
      };
      this.player.resetAt(spawn.x, spawn.y);
    } else if (dir === "east" && gen.rightDoorTileX >= 0) {
      spawn = {
        x: (gen.rightDoorTileX - 1) * TILE_SIZE,
        y: (gen.rightDoorTopTileY + 2) * TILE_SIZE - 32,
      };
      this.player.resetAt(spawn.x, spawn.y);
    } else {
      const spawnTx = roomSpawnTx(node, this.map, dir === "west", dir === "east");
      spawn = spawnAtFloor(this.map, spawnTx);
      this.player.resetAt(spawn.x, spawn.y);
    }

    const bounds = this.scrollBounds();
    this.camera.reset(
      clamp(this.cameraAnchorX(), bounds.minAnchorX, bounds.maxAnchorX),
      clamp(this.cameraAnchorY(), bounds.minAnchorY, bounds.maxAnchorY)
    );
    this.transitionFade = 1;
    this.transitionDir = dir;
    input?.clearHardwareStateForRoomTransition?.();
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
      hpRed: this.player.health.getRedCurrent(),
      hpRedMax: this.player.health.getRedMax(),
      keys: this.player.stats.keys,
      money: this.player.stats.money,
      roomKind: this.layout.room(this.currentRoomId).kind,
      displaySalt: this.layout.room(this.currentRoomId).contentSeed >>> 0,
      seed: this.seed,
      gameOver: this.gameOver,
      layout: this.layout,
      currentRoomId: this.currentRoomId,
      roomVisited: this.roomVisited,
      minimapAdjacentSeen: this.minimapAdjacentSeen,
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

function hudHeartSlotCount(redMax){
  return Math.max(1, Math.floor((redMax + 1) / 2));
}

/** UI health strip: 0 = full, 1 = half, 2 = empty. */
function uiHeartFrameIndexForSlot(slotIndex, currentHp, maxHp){
  const capacity = Math.min(2, maxHp - 2 * slotIndex);
  if (capacity <= 0) return 2;
  const filled = Math.min(capacity, Math.max(0, currentHp - 2 * slotIndex));
  if (filled >= 2) return 0;
  if (filled >= 1) return 1;
  return 2;
}

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
    this.gameOverRestartRect = null;
    this.gameOverRetryRect = null;
  }

  draw(sim, snap, assets, tilesetRuntime){
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

    this.drawTiles(ctx, sim, snap, assets, tilesetRuntime);
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

    if (snap.gameOver) {
      this.drawGameOverOverlay(ctx);
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

  drawTiles(ctx, sim, snap, assets, tilesetRuntime){
    const map = sim.map;
    const camX = snap.cameraX;
    const camY = snap.cameraY;
    const viewWorldW = WORLD_VIEWPORT_W;
    const viewWorldH = WORLD_VIEWPORT_H / CAMERA_ZOOM;
    const viewLeft = camX - viewWorldW / 2;
    const viewTop = camY - viewWorldH / 2;
    const x0 = Math.max(0, Math.floor(viewLeft / TILE_SIZE) - 1);
    const y0 = Math.max(0, Math.floor(viewTop / TILE_SIZE) - 1);
    const x1 = Math.min(map.getWidth() - 1, Math.ceil((viewLeft + viewWorldW) / TILE_SIZE) + 1);
    const y1 = Math.min(map.getHeight() - 1, Math.ceil((viewTop + viewWorldH) / TILE_SIZE) + 1);

    const forest = assets.get("tiles/forest tileset.png");
    const underground = assets.get("tiles/underground tileset.png");
    const sheet =
      underground && imageDrawable(underground) ? underground : forest;

    this.drawSkyBackground(ctx, map, x0, y0, x1, y1, sheet);

    // Always paint forest/underground sprite terrain first so floors stay visible even
    // when tileset v3 only manages partial draws (e.g. grass without solids).
    this.drawTilesSpriteLayer(ctx, sim, map, x0, y0, x1, y1, sheet);

    if (tilesetRuntime) {
      try {
        tilesetRuntime.drawRoom(ctx, map, {
          roomKind: snap.roomKind,
          displaySalt: snap.displaySalt >>> 0,
          x0,
          y0,
          x1,
          y1,
        });
      } catch (err) {
        console.error("[Vernan] tileset draw failed:", err);
      }
    }
  }

  drawSkyBackground(ctx, map, x0, y0, x1, y1, sheet) {
    if (!imageDrawable(sheet)) return;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (map.tileAt(tx, ty) !== TILE_EMPTY) continue;
        drawForestTile(ctx, sheet, 0, 0, tx * TILE_SIZE, ty * TILE_SIZE);
      }
    }
  }

  drawTilesSpriteLayer(ctx, sim, map, x0, y0, x1, y1, sheet) {
    const forest = sheet;
    const canSprite = imageDrawable(forest);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const t = map.tileAt(tx, ty);
        if (t === TILE_EMPTY && isFloorTerrainTile(map, tx, ty + 1)) {
          const px = tx * TILE_SIZE;
          const py = ty * TILE_SIZE;
          if (!canSprite || !drawForestTile(ctx, forest, 1, 0, px, py)) {
            ctx.fillStyle = "#5a8f4a";
            ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
          }
        }
      }
    }

    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        let t = map.tileAt(tx, ty);
        const px = tx * TILE_SIZE;
        const py = ty * TILE_SIZE;
        if (t === TILE_BREAKABLE && sim.isHiddenShellBreakable(tx, ty)) {
          t = TILE_SOLID;
        }
        if (t === TILE_SOLID || t === TILE_BREAKABLE) {
          const [col, row] = solidAutotileCell(map, tx, ty);
          if (!canSprite || !drawForestTile(ctx, forest, col, row, px, py)) {
            ctx.fillStyle = tileToColor(t);
            ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
          }
        } else if (t === TILE_PLATFORM) {
          if (!canSprite || !drawForestTile(ctx, forest, 0, 1, px, py)) {
            ctx.fillStyle = tileToColor(t);
            ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
          }
        } else if (t === TILE_LADDER) {
          if (!canSprite || !drawForestTile(ctx, forest, 2, 5, px, py)) {
            ctx.fillStyle = tileToColor(t);
            ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
          }
        } else if (t === TILE_DOOR) {
          const doorTop = ty + 1 < map.getHeight() && map.tileAt(tx, ty + 1) === TILE_DOOR;
          const [col, row] = doorTop ? [2, 9] : [3, 10];
          if (!canSprite || !drawForestTile(ctx, forest, col, row, px, py)) {
            ctx.fillStyle = tileToColor(t);
            ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
          }
        }
      }
    }
  }

  drawPlayer(ctx, snap, assets){
    const sheet = assets.get("sprites/" + snap.spriteName);
    const feetY = snap.playerY + 18;
    const drawX = snap.playerX + 5 - SPRITE_FRAME_W / 2;
    const drawY = feetY - SPRITE_FRAME_H;
    const attacking = snap.spriteName.includes("attack");

    if (imageDrawable(sheet)) {
      const frame = snap.spriteFrame;
      const fw = SPRITE_FRAME_W;
      ctx.save();
      if (snap.facing < 0) {
        ctx.translate(drawX + fw, drawY);
        ctx.scale(-1, 1);
        ctx.drawImage(sheet, frame * fw, 0, fw, SPRITE_FRAME_H, 0, 0, fw, SPRITE_FRAME_H);
      } else {
        ctx.drawImage(sheet, frame * fw, 0, fw, SPRITE_FRAME_H, drawX, drawY, fw, SPRITE_FRAME_H);
      }
      if (snap.playerHurtTint > 0) {
        const a = snap.playerHurtTint / 0.35;
        ctx.globalCompositeOperation = "source-atop";
        ctx.fillStyle = `rgba(255,64,64,${0.35 + 0.45 * a})`;
        ctx.fillRect(0, 0, fw, SPRITE_FRAME_H);
      }
      ctx.restore();
      if (attacking) this.drawAttackWeaponOverlay(ctx, snap, assets, drawY);
    } else {
      ctx.fillStyle = snap.playerHurtTint > 0 ? "#ffaaaa" : "#e8a87c";
      ctx.fillRect(snap.playerX, snap.playerY, 10, 18);
    }
  }

  drawAttackWeaponOverlay(ctx, snap, assets, bodyTopY){
    const sword = assets.get("sprites/sword attack.png");
    if (!imageDrawable(sword)) return;
    const frame = snap.spriteFrame;
    const fw = WEAPON_ATTACK_FRAME_W;
    const fh = WEAPON_ATTACK_FRAME_H;
    const bodyLeft = snap.playerX + PLAYER_STAND_W * 0.5 - WEAPON_ATTACK_BODY_W * 0.5;
    const weaponX =
      snap.facing >= 0 ? bodyLeft : bodyLeft - WEAPON_ATTACK_EXTENSION_PX;
    ctx.save();
    if (snap.facing < 0) {
      ctx.translate(weaponX + fw, bodyTopY);
      ctx.scale(-1, 1);
      ctx.drawImage(sword, frame * fw, 0, fw, fh, 0, 0, fw, fh);
    } else {
      ctx.drawImage(sword, frame * fw, 0, fw, fh, weaponX, bodyTopY, fw, fh);
    }
    ctx.restore();
  }

  drawEnemies(
    ctx,
    snap,
    assets
  ){
    const sheet = assets.get("sprites/crawler.png");
    for (const e of snap.enemies) {
      if (e.dead) continue;
      if (imageDrawable(sheet)) {
        const feetY = e.y + ENEMY_CRAWLER_HITBOX_H;
        const drawX = e.x + 4 - ENEMY_CRAWLER_SPRITE_W / 2;
        const drawY = feetY - ENEMY_CRAWLER_SPRITE_H;
        ctx.drawImage(
          sheet,
          e.animFrame * ENEMY_CRAWLER_SPRITE_W,
          0,
          ENEMY_CRAWLER_SPRITE_W,
          ENEMY_CRAWLER_SPRITE_H,
          drawX,
          drawY,
          ENEMY_CRAWLER_SPRITE_W,
          ENEMY_CRAWLER_SPRITE_H
        );
      } else {
        ctx.fillStyle = e.hurtTint > 0 ? "#ff8888" : "#88ff88";
        ctx.fillRect(e.x, e.y, 8, ENEMY_CRAWLER_HITBOX_H);
      }
    }
  }

  drawHud(ctx, snap, assets){
    const hudY = INTERNAL_HEIGHT - HUD_HEIGHT;
    ctx.fillStyle = "#111118";
    ctx.fillRect(0, hudY, INTERNAL_WIDTH, HUD_HEIGHT);

    const heart = assets.get("sprites/UI health.png");
    const heartSlots = hudHeartSlotCount(snap.hpRedMax);
    const frameW = heart ? Math.max(1, heart.width / 3) : 8;
    const PAD_L = 6;
    const HEART_SLOT = 16;
    const HEART_GAP = 2;
    let hx = PAD_L;
    for (let slot = 0; slot < heartSlots; slot++) {
      const fi = uiHeartFrameIndexForSlot(slot, snap.hpRed, snap.hpRedMax);
      if (imageDrawable(heart)) {
        ctx.drawImage(
          heart,
          fi * frameW,
          0,
          frameW,
          heart.height,
          hx,
          hudY + 4,
          HEART_SLOT,
          HEART_SLOT
        );
      } else {
        ctx.fillStyle = fi === 0 ? "#e74c3c" : fi === 1 ? "#c0392b" : "#333";
        ctx.fillRect(hx, hudY + 4, HEART_SLOT, HEART_SLOT);
      }
      hx += HEART_SLOT + HEART_GAP;
    }

    ctx.fillStyle = "#aaa";
    ctx.font = "8px monospace";
    ctx.fillText(`Keys:${snap.keys} $:${snap.money}`, 8, hudY + 28);
    drawMinimap(ctx, snap, hudY);
    const grid = snap.layout ? minimapGridMetrics(snap.layout) : null;
    const roomLabelX = grid ? Math.max(8, INTERNAL_WIDTH - grid.totalW - 90) : INTERNAL_WIDTH - 120;
    ctx.fillText(snap.roomKind, roomLabelX, hudY + 28);
  }

  drawGameOverOverlay(ctx){
    ctx.fillStyle = "rgba(0,0,0,0.74)";
    ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 16px monospace";
    ctx.fillStyle = "#ffffff";
    ctx.fillText("GAME OVER", INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2 - 22);

    ctx.font = "12px monospace";
    ctx.fillStyle = "rgba(255,255,255,0.63)";
    ctx.fillText("Restart with a new seed", INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2 - 6);

    const bw = 210;
    const bh = 22;
    const bx = Math.floor(INTERNAL_WIDTH / 2 - bw / 2);
    const by = Math.floor(INTERNAL_HEIGHT / 2 + 10);
    this.gameOverRestartRect = { x: bx, y: by, w: bw, h: bh };
    ctx.strokeStyle = "rgba(255,255,255,0.78)";
    ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = "rgba(255,255,255,0.24)";
    ctx.fillRect(bx + 1, by + 1, bw - 2, bh - 2);
    ctx.fillStyle = "#ffffff";
    ctx.fillText("RESTART (NEW SEED)", INTERNAL_WIDTH / 2, by + bh / 2);

    const retryBw = 170;
    const retryBh = 18;
    const retryBx = Math.floor(INTERNAL_WIDTH / 2 - retryBw / 2);
    const retryBy = by + bh + 12;
    this.gameOverRetryRect = { x: retryBx, y: retryBy, w: retryBw, h: retryBh };
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.strokeRect(retryBx, retryBy, retryBw, retryBh);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(retryBx + 1, retryBy + 1, retryBw - 2, retryBh - 2);
    ctx.fillStyle = "rgba(255,255,255,0.86)";
    ctx.fillText("RETRY (SAME SEED)", INTERNAL_WIDTH / 2, retryBy + retryBh / 2);

    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  hitGameOverRestart(ix, iy){
    const r = this.gameOverRestartRect;
    return r && ix >= r.x && ix < r.x + r.w && iy >= r.y && iy < r.y + r.h;
  }

  hitGameOverRetry(ix, iy){
    const r = this.gameOverRetryRect;
    return r && ix >= r.x && ix < r.x + r.w && iy >= r.y && iy < r.y + r.h;
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

function newRandomSeed(){
  return ((Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0);
}

async function mount(selector, options = {}){
  const root =
    typeof selector === "string"
      ? document.querySelector(selector)
      : selector;
  if (!root) throw new Error("VernanWeb.mount: root element not found");

  const assetBaseRaw = options.assetBase ?? "assets/vernan/";
  if (!assetBaseRaw.endsWith("/")) throw new Error("assetBase must end with /");
  const assetBase = new URL(assetBaseRaw, window.location.href).href;

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

  let tilesetRuntime = null;
  if (typeof VernanTileset !== "undefined") {
    try {
      tilesetRuntime = await Promise.race([
        VernanTileset.TilesetRuntime.load(assetBase, (rel) => loader.loadImage(rel)),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("tileset load timeout")), 30000)
        ),
      ]);
    } catch (err) {
      console.warn("[Vernan] tileset load failed; using forest sprite tiles:", err);
    }
  } else {
    console.warn("[Vernan] vernan-tileset.js missing — using forest sprite tiles only");
  }

  loadingEl.style.display = "none";
  canvas.focus();
  canvas.addEventListener("click", () => canvas.focus());

  const sim = new GameSim({ seed, assetLoader: loader, itemCatalog });
  const pipeline = new RenderPipeline(canvas);
  const input = new Input();
  const unbindInput = input.bind(canvas);

  const updateStatus = () => {
    statusEl.textContent = `v${WEB_CLIENT_VERSION_STR} · seed ${sim.getSeed()} · layout ${layoutHash(sim.layout)}`;
  };
  updateStatus();

  const onGameOverClick = (e) => {
    if (!sim.gameOver) return;
    const rect = canvas.getBoundingClientRect();
    const ix = ((e.clientX - rect.left) / rect.width) * INTERNAL_WIDTH;
    const iy = ((e.clientY - rect.top) / rect.height) * INTERNAL_HEIGHT;
    if (pipeline.hitGameOverRestart(ix, iy)) {
      sim.restartRun(newRandomSeed());
      input.clearHardwareState();
      updateStatus();
    } else if (pipeline.hitGameOverRetry(ix, iy)) {
      sim.restartRun(sim.getSeed());
      input.clearHardwareState();
      updateStatus();
    }
  };
  canvas.addEventListener("click", onGameOverClick);

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
      try {
        pipeline.draw(sim, sim.renderAlpha(alpha), loader, tilesetRuntime);
      } catch (err) {
        console.error("[Vernan] render failed:", err);
      }
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
    canvas.removeEventListener("click", onGameOverClick);
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
