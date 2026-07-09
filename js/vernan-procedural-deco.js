/**
 * Procedural room deco + NORMAL biome terrain bridge (Java RoomGenerator / NormalRoomBiomes port).
 */
(function (global) {
  "use strict";

  const PICK_SALT = 0xb10eb10e;
  const TILE_SOLID = 1;
  const TILE_BREAKABLE = 5;

  function asMap(v) {
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  }
  function asList(v) {
    return Array.isArray(v) ? v : null;
  }
  function str(m, key, fallback = "") {
    const v = m?.[key];
    return typeof v === "string" ? v : fallback;
  }
  function num(m, key, fallback = 0) {
    const v = m?.[key];
    return typeof v === "number" ? v : fallback;
  }

  function packCell(tx, ty) {
    return (BigInt(ty) << 32n) | (BigInt(tx) & 0xffffffffn);
  }

  function findObjectById(objects, objectId) {
    const want = String(objectId || "").trim();
    if (!want || !objects) return null;
    for (const raw of objects) {
      const o = asMap(raw);
      if (o && str(o, "id", "").trim() === want) return o;
    }
    return null;
  }

  function findObjectOwningTileId(objects, tileId) {
    const want = String(tileId || "").trim();
    if (!want || !objects) return null;
    for (const raw of objects) {
      const o = asMap(raw);
      if (!o) continue;
      for (const tid of asList(o.tileIds) || []) {
        if (String(tid).trim() === want) return o;
      }
      const cells = asList(asMap(o.memberGraphLayout)?.cells);
      if (cells) {
        for (const c of cells) {
          if (str(asMap(c), "tileId", "").trim() === want) return o;
        }
      }
    }
    return null;
  }

  function memberTileIdsOrdered(obj) {
    const out = [];
    const seen = new Set();
    const push = (id) => {
      const t = String(id || "").trim();
      if (!t || seen.has(t)) return;
      seen.add(t);
      out.push(t);
    };
    for (const tid of asList(obj?.tileIds) || []) push(tid);
    const cells = asList(asMap(obj?.memberGraphLayout)?.cells);
    if (cells) {
      const sorted = cells.map((c) => asMap(c)).filter(Boolean);
      sorted.sort((a, b) => num(a, "col", 0) - num(b, "col", 0) || num(a, "row", 0) - num(b, "row", 0));
      for (const c of sorted) push(str(c, "tileId", ""));
    }
    return out;
  }

  function mapTerrainOnObject(obj) {
    const mt = str(obj, "mapTerrain", "");
    if (mt) return mt.toUpperCase();
    return str(asMap(obj?.editorObjectDefaults), "mapTerrain", "EMPTY").toUpperCase();
  }

  function terrainCode(name) {
    const n = String(name || "").toUpperCase();
    return (
      { EMPTY: 0, SOLID: 1, DOOR: 2, PLATFORM: 3, LADDER: 4, BREAKABLE: 5 }[n] ?? -1
    );
  }

  function isGardeningPluckableObject(objects, objectId) {
    const obj = findObjectById(objects, objectId);
    if (obj) {
      if (obj.gardeningPluckable === true) return true;
      const id = str(obj, "id", "");
      return id === "grass" || id === "blue grass" || id === "LA grass" || id === "grass dead";
    }
    const id = String(objectId || "").trim();
    return id === "grass" || id === "blue grass";
  }

  function resolveObjectIdForTile(objects, tileId) {
    const obj = findObjectOwningTileId(objects, tileId);
    return obj ? str(obj, "id", "") : tileId;
  }

  function isGrassTuftDeco(objects, decoTileId) {
    if (!decoTileId) return false;
    const oid = resolveObjectIdForTile(objects, decoTileId);
    return isGardeningPluckableObject(objects, oid);
  }

  function decoBlobClusterChannel(objects, objectId) {
    const obj = findObjectById(objects, objectId);
    const ch = str(obj, "decoBlobClusterChannel", "").toLowerCase();
    return ch === "red" || ch === "blue" ? ch : "";
  }

  function parseWeightedPool(entries) {
    const out = [];
    for (const raw of entries || []) {
      const e = asMap(raw);
      if (!e) continue;
      const objectId = str(e, "objectId", "").trim();
      if (!objectId) continue;
      let weight = num(e, "weight", 1);
      if (weight <= 0) weight = 1;
      out.push({ objectId, weight });
    }
    return out;
  }

  function expandDecoPool(tilesetRoot, objects, roomKind, biomeRow) {
    const kind = String(roomKind || "NORMAL").toUpperCase();
    const prg = asMap(tilesetRoot?.proceduralRoomGen) || {};
    const byKind = asMap(prg.decoPoolsByRoomKind);
    const entries = [];
    const biomePool = parseWeightedPool(asList(biomeRow?.decoPool));
    if (biomePool.length) entries.push(...biomePool);
    else entries.push(...parseWeightedPool(asList(byKind?.[kind])));
    if (!entries.length) entries.push(...parseWeightedPool(asList(byKind?.NORMAL)));
    const out = [];
    for (const e of entries) {
      const obj = findObjectById(objects, e.objectId);
      const members = obj ? memberTileIdsOrdered(obj) : [];
      const tileId = members[0] || e.objectId;
      out.push({ objectId: e.objectId, tileId, weight: e.weight });
    }
    return out;
  }

  function poolForChannel(fullPool, objects, redChannel) {
    const filtered = [];
    for (const e of fullPool) {
      const ch = decoBlobClusterChannel(objects, e.objectId);
      if (!ch || (redChannel && ch === "red") || (!redChannel && ch === "blue")) {
        filtered.push(e);
      }
    }
    return filtered.length ? filtered : fullPool;
  }

  function pickWeightedEntry(rng, entries) {
    if (!entries.length) return null;
    let total = 0;
    for (const e of entries) total += e.weight;
    let roll = rng.nextInt(Math.max(1, total));
    for (const e of entries) {
      roll -= e.weight;
      if (roll < 0) return e;
    }
    return entries[entries.length - 1];
  }

  function pickBiomeId(biomes, rng) {
    if (!biomes.length) return "default";
    let total = 0;
    for (const b of biomes) total += Math.max(0, num(b, "weight", 1));
    if (!rng || total <= 0) return str(biomes[0], "id", "default");
    let roll = rng.nextInt(total);
    for (const b of biomes) {
      roll -= Math.max(0, num(b, "weight", 1));
      if (roll < 0) return str(b, "id", "default");
    }
    return str(biomes[biomes.length - 1], "id", "default");
  }

  function biomesForSheet(tilesetRoot, sheetId = "main") {
    const prg = asMap(tilesetRoot?.proceduralRoomGen) || {};
    const bySheet = asMap(prg.normalBiomesBySheet);
    const list = asList(bySheet?.[sheetId]) || asList(prg.normalBiomes) || [];
    return list.map((x) => asMap(x)).filter(Boolean);
  }

  function resolveRoomBiome(tilesetRuntime, roomKind, contentSeed, rng) {
    if (!tilesetRuntime?.root || String(roomKind).toUpperCase() !== "NORMAL") {
      return { biomeId: null, biomeRow: null, proceduralRoot: asMap(tilesetRuntime?.root?.proceduralRoomGen) };
    }
    const biomes = biomesForSheet(tilesetRuntime.root, "main");
    const biomeRng =
      rng ||
      (global.VernanWeb?.javaRandom
        ? global.VernanWeb.javaRandom(Number(BigInt(contentSeed) ^ BigInt(PICK_SALT)))
        : null);
    const biomeId = pickBiomeId(biomes, biomeRng);
    const biomeRow = biomes.find((b) => str(b, "id", "") === biomeId) || biomes[0] || null;
    return { biomeId, biomeRow, proceduralRoot: asMap(tilesetRuntime.root.proceduralRoomGen) };
  }

  function buildRoomTerrainBridge(tilesetRuntime, biomeRow, roomKind) {
    const base = tilesetRuntime.bridge;
    if (!base?.withBiomePoolOverrides) return base;
    const kind = String(roomKind || "NORMAL").toUpperCase();
    const prg = asMap(tilesetRuntime.root?.proceduralRoomGen);
    const byKind = asMap(prg?.terrainBridgePoolByRoomKind);
    let pool = parseWeightedPool(asList(biomeRow?.terrainBridgePool));
    if (!pool.length) pool = parseWeightedPool(asList(byKind?.[kind]));
    if (!pool.length) return base;
    return base.withBiomePoolOverrides(tilesetRuntime.objects || [], pool, str(biomeRow, "id", "default") !== "default");
  }

  function blobCellGroundHugging(grid, tx, ty) {
    const below = ty + 1;
    if (!grid || below >= grid.length) return false;
    return grid[below][tx] === "#";
  }

  function decoCellIsOpenAir(grid, tx, ty) {
    if (!grid || ty < 0 || ty >= grid.length) return false;
    if (tx < 0 || tx >= grid[ty].length) return false;
    return grid[ty][tx] === ".";
  }

  function indexDecoByCell(decoTiles) {
    const map = new Map();
    for (const d of decoTiles || []) {
      if (d.decoTileId) map.set(packCell(d.tx, d.ty), d.decoTileId);
    }
    return map;
  }

  function scatterRoomDeco(opts) {
    const {
      grid,
      w,
      h,
      contentSeed,
      ladderTx,
      roomKind,
      tilesetRoot,
      objects,
      biomeRow,
      rng,
      tilesetRuntime = null,
    } = opts;
    const kind = String(roomKind || "NORMAL").toUpperCase();
    if (kind === "SECRET" || kind === "SUPER_SECRET") return [];

    const breakableChanceMap =
      global.VernanBreakables?.buildDecoBreakableChanceMap(tilesetRuntime) ?? null;

    const prg = asMap(tilesetRoot?.proceduralRoomGen) || {};
    const tunablesByKind = asMap(prg.tunablesByRoomKind);
    const tunables = { ...asMap(prg.tunables), ...asMap(biomeRow?.tunables), ...asMap(tunablesByKind?.[kind]) };
    const cmin = tunables.decoClusterCountMin ?? 3;
    const cmax = tunables.decoClusterCountMax ?? 6;
    const clusters = cmin + (cmax > cmin ? rng.nextInt(cmax - cmin + 1) : 0);

    const fullPool = expandDecoPool(tilesetRoot, objects, kind, biomeRow);
    const poolRed = poolForChannel(fullPool, objects, true);
    const poolBlue = poolForChannel(fullPool, objects, false);
    const fallback = asMap(biomeRow?.decoClusterFallback) || asMap(prg.decoClusterFallback) || {};

    const deco = [];
    const occupied = new Set();

    const tryPlace = (tx, ty, argb, pool) => {
      const key = `${tx},${ty}`;
      if (occupied.has(key)) return;
      if (!decoCellIsOpenAir(grid, tx, ty)) return;
      if (tx <= 1 || tx >= w - 1 || ty <= 1 || ty >= h - 1) return;
      if (ladderTx >= 0 && tx === ladderTx) return;

      const entry = pickWeightedEntry(rng, pool);
      let decoTileId = entry?.tileId || "";
      if (!decoTileId) {
        const fid = argb === 0x66ff4a4a ? str(fallback, "red", "") : str(fallback, "blue", "");
        if (fid) decoTileId = fid;
      }
      const groundHug = blobCellGroundHugging(grid, tx, ty);
      const breakableDeco =
        decoTileId && breakableChanceMap
          ? global.VernanBreakables.rollBreakableDeco(decoTileId, breakableChanceMap, rng)
          : false;
      deco.push({ tx, ty, argb, decoTileId, breakableDeco, groundHug });
      occupied.add(key);
    };

    for (let i = 0; i < clusters; i++) {
      const red = rng.nextBoolean ? rng.nextBoolean() : rng.nextInt(2) === 0;
      const argb = red ? 0x66ff4a4a : 0x664a8bff;
      const pool = red ? poolRed : poolBlue;
      const cx = 2 + rng.nextInt(Math.max(1, w - 4));
      const baseY = 2 + rng.nextInt(Math.max(1, h - 6));
      const cw = 3 + rng.nextInt(5);
      const ch = 3 + rng.nextInt(6);
      for (let dx = -cw; dx <= cw; dx++) {
        for (let dy = -ch; dy <= ch; dy++) {
          const tx = cx + dx;
          const ty = baseY + dy;
          const nx = dx / cw;
          const ny = dy / ch;
          if (nx * nx + ny * ny > 1) continue;
          if (rng.nextInt(7) === 0) continue;
          tryPlace(tx, ty, argb, pool);
        }
      }
    }

    if (kind === "ITEM" || kind === "SHOP") {
      const gyc = Math.min(h - 2, Math.max(2, Math.floor(h * 0.75)));
      const cx = Math.floor(w / 2);
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          tryPlace(cx + dx, gyc - 1 - dy, 0x664a8bff, fullPool);
        }
      }
    }

    return deco;
  }

  global.VernanProceduralDeco = {
    packCell,
    resolveRoomBiome,
    buildRoomTerrainBridge,
    scatterRoomDeco,
    indexDecoByCell,
    isGrassTuftDeco,
    expandDecoPool,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
