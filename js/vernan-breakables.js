/**
 * Procedural cliff breakables + breakable deco rolls (Java BreakableLootRoll / placeBreakablesOnStepFaces / ProceduralBreakableNav port).
 */
(function (global) {
  "use strict";

  const MAX_PROCEDURAL_BREAKABLES = 6;
  const MAX_VERTICAL_REACH_TILES = 3;
  const DECO_LOOT_HASH = 0xd1b54a32d192ed03n;

  function asMap(v) {
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  }
  function str(m, key, fallback = "") {
    const v = m?.[key];
    return typeof v === "string" ? v : fallback;
  }
  function num(m, key, fallback = 0) {
    const v = m?.[key];
    return typeof v === "number" ? v : fallback;
  }
  function bool(m, key, fallback = false) {
    const v = m?.[key];
    return typeof v === "boolean" ? v : fallback;
  }

  /** Java String.hashCode() — used for deterministic deco loot/brick RNG. */
  function javaStringHash(s) {
    let h = 0;
    const str = String(s ?? "");
    for (let i = 0; i < str.length; i++) {
      h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return h;
  }

  function buildDecoBreakableChanceMap(tilesetRuntime) {
    if (!tilesetRuntime?.tilesById) return null;
    const out = new Map();
    for (const m of tilesetRuntime.tilesById.values()) {
      const id = str(m, "id", "");
      if (!id) continue;
      let can = bool(m, "canBreakAsDeco", false);
      if (!can && bool(m, "breakableDeco", false)) can = true;
      if (!can) continue;
      let p = 1.0;
      const chance = m.breakableDecoChance;
      if (typeof chance === "number") p = Math.max(0, Math.min(1, chance));
      out.set(id, p);
    }
    return out.size ? out : null;
  }

  function rollBreakableDeco(decoTileId, chanceMap, rng) {
    if (!decoTileId || !chanceMap || !rng) return false;
    const p = chanceMap.get(decoTileId) ?? 0;
    if (p <= 0) return false;
    return rng.nextDouble() < p;
  }

  function deepestFloorInColumns(groundY, colLo, colHi) {
    const lo = Math.max(0, colLo);
    const hi = Math.min(groundY.length - 1, colHi);
    let deepest = groundY[lo];
    for (let x = lo + 1; x <= hi; x++) deepest = Math.max(deepest, groundY[x]);
    return deepest;
  }

  function hasSolidSupportBelow(grid, h, x, y) {
    const below = y + 1;
    return below < h - 1 && grid[below][x] === "#";
  }

  function columnHasLadderRung(grid, h, x) {
    for (let y = 1; y < h - 1; y++) {
      if (grid[y][x] === "H") return true;
    }
    return false;
  }

  function isInDungeonShaftCorridorBand(tx, ty, dungeonLadderTx, dungeonLadderFloorRow) {
    if (dungeonLadderTx < 1 || dungeonLadderFloorRow < 2) return false;
    if (Math.abs(tx - dungeonLadderTx) > 2 || tx === dungeonLadderTx) return false;
    return ty >= 1 && ty < dungeonLadderFloorRow;
  }

  function isBelowOrAdjacentBelowLadderFoot(
    tx,
    ty,
    w,
    h,
    grid,
    groundY,
    dungeonLadderTx,
    dungeonLadderFloorRow
  ) {
    for (let lx = 2; lx < w - 2; lx++) {
      if (!columnHasLadderRung(grid, h, lx)) continue;
      const footRow =
        dungeonLadderTx >= 0 && lx === dungeonLadderTx && dungeonLadderFloorRow >= 0
          ? dungeonLadderFloorRow
          : groundY[lx];
      if (Math.abs(tx - lx) <= 1 && ty >= footRow) return true;
    }
    return false;
  }

  function isDoorCell(tx, ty, leftDoorX, rightDoorX, leftDoorTopY, rightDoorTopY) {
    if (leftDoorX >= 0 && tx === leftDoorX && (ty === leftDoorTopY || ty === leftDoorTopY + 1)) return true;
    return rightDoorX >= 0 && tx === rightDoorX && (ty === rightDoorTopY || ty === rightDoorTopY + 1);
  }

  function breakableFaceReachableAfterBreak(faceX, faceY, groundY, mesaRaisedAtFaceX, maxReach) {
    const lowSideX = mesaRaisedAtFaceX ? faceX - 1 : faceX + 1;
    if (lowSideX < 1 || lowSideX >= groundY.length - 1) return false;
    const scanLo = mesaRaisedAtFaceX ? Math.max(1, lowSideX - 2) : lowSideX;
    const scanHi = mesaRaisedAtFaceX ? lowSideX : Math.min(groundY.length - 2, lowSideX + 2);
    const lowFloor = deepestFloorInColumns(groundY, scanLo, scanHi);
    const riseTiles = lowFloor - faceY;
    if (riseTiles <= 0) return true;
    return riseTiles <= maxReach;
  }

  function pack(x, y) {
    return (BigInt(y) << 16n) | (BigInt(x) & 0xffffn);
  }
  function unpackX(p) {
    return Number(p & 0xffffn);
  }
  function unpackY(p) {
    return Number(p >> 16n);
  }

  function effective(grid, proceduralBreakable, x, y) {
    if (proceduralBreakable?.[y]?.[x]) return ".";
    return grid[y][x];
  }

  function isFloorSupport(grid, w, h, proceduralBreakable, x, y) {
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    const c = effective(grid, proceduralBreakable, x, y);
    return c === "#" || c === "-" || c === "H";
  }

  function isBodyPassable(grid, w, h, proceduralBreakable, x, y) {
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    return effective(grid, proceduralBreakable, x, y) !== "#";
  }

  function isStandable(grid, w, h, proceduralBreakable, x, y) {
    if (x < 1 || x >= w - 1 || y < 1 || y >= h - 1) return false;
    if (!isBodyPassable(grid, w, h, proceduralBreakable, x, y)) return false;
    return isFloorSupport(grid, w, h, proceduralBreakable, x, y + 1);
  }

  function tryWalk(grid, w, h, proceduralBreakable, seen, q, x, y) {
    if (!isStandable(grid, w, h, proceduralBreakable, x, y)) return;
    const p = pack(x, y);
    if (!seen.has(p)) {
      seen.add(p);
      q.push(p);
    }
  }

  function tryJump(grid, w, h, proceduralBreakable, seen, q, x, y, dy, maxReach) {
    const ty = y + dy;
    if (ty < 1 || ty >= h - 1) return;
    const step = dy < 0 ? -1 : 1;
    for (let cy = y + step; cy !== ty + step; cy += step) {
      if (!isBodyPassable(grid, w, h, proceduralBreakable, x, cy)) return;
    }
    tryWalk(grid, w, h, proceduralBreakable, seen, q, x, ty);
  }

  function tryFall(grid, w, h, proceduralBreakable, seen, q, x, y) {
    for (let ty = y + 1; ty < h - 1; ty++) {
      if (isStandable(grid, w, h, proceduralBreakable, x, ty)) {
        const p = pack(x, ty);
        if (!seen.has(p)) {
          seen.add(p);
          q.push(p);
        }
        return;
      }
      if (!isBodyPassable(grid, w, h, proceduralBreakable, x, ty)) return;
    }
  }

  function bfsReachableStandpoints(grid, w, h, groundY, proceduralBreakable, seeds, maxReach) {
    const seen = new Set();
    const q = [];
    for (const s of seeds) {
      const x = unpackX(s);
      const y = unpackY(s);
      if (isStandable(grid, w, h, proceduralBreakable, x, y)) {
        seen.add(s);
        q.push(s);
      }
    }
    while (q.length) {
      const cur = q.shift();
      const x = unpackX(cur);
      const y = unpackY(cur);
      tryWalk(grid, w, h, proceduralBreakable, seen, q, x - 1, y);
      tryWalk(grid, w, h, proceduralBreakable, seen, q, x + 1, y);
      for (let jump = 1; jump <= maxReach; jump++) {
        tryJump(grid, w, h, proceduralBreakable, seen, q, x, y, -jump, maxReach);
        tryJump(grid, w, h, proceduralBreakable, seen, q, x, y, jump, maxReach);
      }
      tryFall(grid, w, h, proceduralBreakable, seen, q, x, y);
    }
    return seen;
  }

  function addPacked(seen, out, x, y) {
    const p = pack(x, y);
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }

  function addStandableNear(grid, w, h, proceduralBreakable, seen, out, x, y) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 1 || nx >= w - 1 || ny < 1 || ny >= h - 1) continue;
        if (isStandable(grid, w, h, proceduralBreakable, nx, ny)) addPacked(seen, out, nx, ny);
      }
    }
  }

  function isAirBesideFace(grid, faceX, faceY, dx) {
    const nx = faceX + dx;
    if (nx < 1 || nx >= grid[0].length - 1 || faceY < 1 || faceY >= grid.length - 1) return false;
    return grid[faceY][nx] === ".";
  }

  function addPlayFloorStandpoint(grid, w, h, groundY, proceduralBreakable, seen, out, x) {
    if (x < 1 || x >= w - 1) return;
    const y = groundY[x] - 1;
    if (y >= 1 && isStandable(grid, w, h, proceduralBreakable, x, y)) addPacked(seen, out, x, y);
  }

  function addPlayFloorRegionBesideCliff(
    grid,
    w,
    h,
    groundY,
    exits,
    proceduralBreakable,
    seen,
    out,
    faceX,
    faceY
  ) {
    if (isAirBesideFace(grid, faceX, faceY, -1)) {
      const westEnd = exits.doorWest && exits.leftDoorX >= 0 ? exits.leftDoorX + 1 : 1;
      for (let x = westEnd; x < faceX; x++) {
        addPlayFloorStandpoint(grid, w, h, groundY, proceduralBreakable, seen, out, x);
      }
    }
    if (isAirBesideFace(grid, faceX, faceY, 1)) {
      const eastStart = faceX + 1;
      const eastEnd = exits.doorEast && exits.rightDoorX >= 0 ? exits.rightDoorX : w - 2;
      for (let x = eastStart; x < eastEnd; x++) {
        addPlayFloorStandpoint(grid, w, h, groundY, proceduralBreakable, seen, out, x);
      }
    }
  }

  function lowSideColumnForFace(faceX, faceY, grid, w, h) {
    if (faceX >= 2 && faceY >= 1 && faceY < h - 1 && grid[faceY][faceX] !== "#") {
      if (faceX - 1 >= 1 && grid[faceY][faceX - 1] === ".") return faceX - 1;
    }
    if (faceX < w - 2 && faceY >= 1 && grid[faceY][faceX] !== "#") {
      if (grid[faceY][faceX + 1] === ".") return faceX + 1;
    }
    return -1;
  }

  function collectExitStandpoints(grid, w, h, groundY, exits) {
    const seen = new Set();
    const out = [];
    if (exits.doorWest && exits.leftDoorX >= 0 && exits.leftDoorTopY >= 0) {
      addStandableNear(grid, w, h, null, seen, out, exits.leftDoorX + 1, exits.leftDoorTopY + 2);
      addStandableNear(grid, w, h, null, seen, out, exits.leftDoorX, exits.leftDoorTopY + 2);
    }
    if (exits.doorEast && exits.rightDoorX >= 0 && exits.rightDoorTopY >= 0) {
      addStandableNear(grid, w, h, null, seen, out, exits.rightDoorX - 1, exits.rightDoorTopY + 2);
      addStandableNear(grid, w, h, null, seen, out, exits.rightDoorX, exits.rightDoorTopY + 2);
    }
    if (exits.ladderTx >= 1 && exits.ladderTx < w - 1) {
      const foot = exits.ladderFloorRow >= 0 ? exits.ladderFloorRow : groundY[exits.ladderTx];
      addStandableNear(grid, w, h, null, seen, out, exits.ladderTx, foot - 1);
      addStandableNear(grid, w, h, null, seen, out, exits.ladderTx, foot);
    }
    return out;
  }

  function requiredStandpoints(grid, w, h, groundY, exits, proceduralMask) {
    const seen = new Set();
    const out = [];
    const entryX = Math.min(2, w - 3);
    const entryY = groundY[entryX] - 1;
    if (entryY >= 1 && isStandable(grid, w, h, proceduralMask, entryX, entryY)) {
      addPacked(seen, out, entryX, entryY);
    }
    if (exits.doorWest && exits.leftDoorX >= 0 && exits.leftDoorTopY >= 0) {
      addStandableNear(grid, w, h, proceduralMask, seen, out, exits.leftDoorX + 1, exits.leftDoorTopY + 2);
    }
    if (exits.doorEast && exits.rightDoorX >= 0 && exits.rightDoorTopY >= 0) {
      addStandableNear(grid, w, h, proceduralMask, seen, out, exits.rightDoorX - 1, exits.rightDoorTopY + 2);
    }
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (!proceduralMask[y][x]) continue;
        const lowX = lowSideColumnForFace(x, y, grid, w, h);
        if (lowX >= 1) {
          const lowY = groundY[lowX] - 1;
          if (lowY >= 1 && isStandable(grid, w, h, proceduralMask, lowX, lowY)) {
            addPacked(seen, out, lowX, lowY);
          }
        }
        addPlayFloorRegionBesideCliff(grid, w, h, groundY, exits, proceduralMask, seen, out, x, y);
      }
    }
    return out;
  }

  function toBreakableMask(w, h, proceduralBreakables) {
    const mask = Array.from({ length: h }, () => new Array(w).fill(false));
    for (const c of proceduralBreakables) {
      const tx = c[0];
      const ty = c[1];
      if (tx >= 0 && tx < w && ty >= 0 && ty < h) mask[ty][tx] = true;
    }
    return mask;
  }

  function isNavigableAfterBreaking(grid, w, h, groundY, exits, proceduralBreakables, maxReach) {
    if (!proceduralBreakables?.length) return true;
    const mask = toBreakableMask(w, h, proceduralBreakables);
    const exitStandpoints = collectExitStandpoints(grid, w, h, groundY, exits);
    if (!exitStandpoints.length) return true;
    const reachable = bfsReachableStandpoints(
      grid,
      w,
      h,
      groundY,
      mask,
      exitStandpoints,
      maxReach
    );
    if (!reachable.size) return false;
    for (const start of requiredStandpoints(grid, w, h, groundY, exits, mask)) {
      if (!reachable.has(start)) return false;
    }
    return true;
  }

  function shuffleInPlace(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = rng.nextInt(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
  }

  function placeBreakablesOnStepFaces(opts) {
    const {
      grid,
      w,
      h,
      groundY,
      rng,
      kind,
      leftDoorX = -1,
      rightDoorX = -1,
      leftDoorTopY = -1,
      rightDoorTopY = -1,
      dungeonLadderTx = -1,
      dungeonLadderFloorRow = -1,
      maxReach = MAX_VERTICAL_REACH_TILES,
    } = opts;
    if (kind !== "NORMAL" && kind !== "BOSS") return [];

    const exits = {
      doorWest: leftDoorX >= 0,
      doorEast: rightDoorX >= 0,
      leftDoorX,
      rightDoorX,
      leftDoorTopY,
      rightDoorTopY,
      ladderTx: dungeonLadderTx,
      ladderFloorRow: dungeonLadderFloorRow,
    };

    const cands = [];
    const usedFaceColumns = new Set();

    for (let x = 2; x < w - 2; x++) {
      if (dungeonLadderTx >= 0 && x === dungeonLadderTx) continue;
      if (groundY[x] >= groundY[x - 1]) continue;
      const yLo = groundY[x];
      const yHi = Math.min(yLo + maxReach - 1, groundY[x - 1] - 1);
      if (groundY[x - 1] - groundY[x] > maxReach) continue;
      if (usedFaceColumns.has(x)) continue;
      for (let y = yLo; y <= yHi; y++) {
        if (y < 1 || y >= h - 1) continue;
        if (grid[y][x] !== "#" || grid[y][x - 1] !== ".") continue;
        if (!hasSolidSupportBelow(grid, h, x, y)) continue;
        if (isDoorCell(x, y, leftDoorX, rightDoorX, leftDoorTopY, rightDoorTopY)) continue;
        if (isBelowOrAdjacentBelowLadderFoot(x, y, w, h, grid, groundY, dungeonLadderTx, dungeonLadderFloorRow))
          continue;
        if (isInDungeonShaftCorridorBand(x, y, dungeonLadderTx, dungeonLadderFloorRow)) continue;
        if (!breakableFaceReachableAfterBreak(x, y, groundY, true, maxReach)) continue;
        cands.push([x, y]);
        break;
      }
    }

    for (let x = 2; x < w - 2; x++) {
      if (dungeonLadderTx >= 0 && x === dungeonLadderTx) continue;
      if (groundY[x] >= groundY[x + 1]) continue;
      const yLo = groundY[x];
      const yHi = Math.min(yLo + maxReach - 1, groundY[x + 1] - 1);
      if (groundY[x + 1] - groundY[x] > maxReach) continue;
      if (usedFaceColumns.has(x)) continue;
      for (let y = yLo; y <= yHi; y++) {
        if (y < 1 || y >= h - 1) continue;
        if (grid[y][x] !== "#" || grid[y][x + 1] !== ".") continue;
        if (!hasSolidSupportBelow(grid, h, x, y)) continue;
        if (isDoorCell(x, y, leftDoorX, rightDoorX, leftDoorTopY, rightDoorTopY)) continue;
        if (isBelowOrAdjacentBelowLadderFoot(x, y, w, h, grid, groundY, dungeonLadderTx, dungeonLadderFloorRow))
          continue;
        if (isInDungeonShaftCorridorBand(x, y, dungeonLadderTx, dungeonLadderFloorRow)) continue;
        if (!breakableFaceReachableAfterBreak(x, y, groundY, false, maxReach)) continue;
        cands.push([x, y]);
        break;
      }
    }

    if (!cands.length) return [];

    shuffleInPlace(cands, rng);
    const placed = [];
    for (const c of cands) {
      if (placed.length >= MAX_PROCEDURAL_BREAKABLES) break;
      const tx = c[0];
      const ty = c[1];
      if (dungeonLadderTx >= 0 && tx === dungeonLadderTx) continue;
      if (usedFaceColumns.has(tx)) continue;
      if (
        isBelowOrAdjacentBelowLadderFoot(tx, ty, w, h, grid, groundY, dungeonLadderTx, dungeonLadderFloorRow)
      )
        continue;
      if (isInDungeonShaftCorridorBand(tx, ty, dungeonLadderTx, dungeonLadderFloorRow)) continue;
      if (grid[ty][tx] !== "#") continue;
      grid[ty][tx] = "B";
      placed.push([tx, ty]);
      usedFaceColumns.add(tx);
      if (!isNavigableAfterBreaking(grid, w, h, groundY, exits, placed, maxReach)) {
        grid[ty][tx] = "#";
        placed.pop();
        usedFaceColumns.delete(tx);
      }
    }
    return placed;
  }

  function decoRngSeed(runSeed, roomId, deco, lootSalt = 0n) {
    const idHash = BigInt(javaStringHash(deco.decoTileId)) * DECO_LOOT_HASH;
    return Number(
      BigInt(runSeed >>> 0) ^
        BigInt(deco.tx) * 0x9e3779b1n ^
        BigInt(deco.ty) * 0x85ebca77n ^
        BigInt(roomId) * 37n ^
        idHash ^
        lootSalt
    );
  }

  function navGridWithOpenedShells(map) {
    const w = map.getWidth();
    const h = map.getHeight();
    const grid = Array.from({ length: h }, () => new Array(w).fill("."));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = map.tileAt(x, y);
        if (t === 2 || t === 5) grid[y][x] = ".";
        else if (t === 0) grid[y][x] = ".";
        else if (t === 1) grid[y][x] = "#";
        else if (t === 3) grid[y][x] = "-";
        else if (t === 4) grid[y][x] = "H";
        else grid[y][x] = ".";
      }
    }
    return grid;
  }

  function canReachBetween(map, groundY, starts, goals) {
    if (!starts?.length || !goals?.length) return true;
    const w = map.getWidth();
    const h = map.getHeight();
    const grid = navGridWithOpenedShells(map);
    const goalSet = new Set(goals.map((g) => pack(g[0], g[1])));
    const seeds = [];
    for (const s of starts) {
      if (isStandable(grid, w, h, null, s[0], s[1])) seeds.push(pack(s[0], s[1]));
    }
    if (!seeds.length) return false;
    const reachable = bfsReachableStandpoints(grid, w, h, groundY, null, seeds, MAX_VERTICAL_REACH_TILES);
    for (const g of goalSet) {
      if (reachable.has(g)) return true;
    }
    return false;
  }

  global.VernanBreakables = {
    MAX_PROCEDURAL_BREAKABLES,
    buildDecoBreakableChanceMap,
    rollBreakableDeco,
    placeBreakablesOnStepFaces,
    isNavigableAfterBreaking,
    canReachBetween,
    decoRngSeed,
    javaStringHash,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
