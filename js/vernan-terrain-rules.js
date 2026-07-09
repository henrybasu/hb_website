/**
 * Terrain hygiene + interior pillar/pit rules (Java TerrainSolidConnectivity / SecretRoomMapBuild port).
 */
(function (global) {
  "use strict";

  const TILE_EMPTY = 0;
  const TILE_SOLID = 1;
  const TILE_DOOR = 2;
  const TILE_PLATFORM = 3;
  const TILE_LADDER = 4;
  const TILE_BREAKABLE = 5;

  const MAX_STEP_HEIGHT = 3;
  const MIN_INTERIOR_GAP_WIDTH = 3;
  const NARROW_GAP_MIN_FLANK_HEIGHT = 3;
  const INTERIOR_PILLAR_DEFAULT_CAP = 2;

  function isStackSolid(t) {
    return t === TILE_SOLID || t === TILE_BREAKABLE;
  }
  function isStackSolidChar(c) {
    return c === "#" || c === "B";
  }

  function isFloorSurface(map, x, y) {
    const t = map.tileAt(x, y);
    if (t !== TILE_SOLID && t !== TILE_PLATFORM) return false;
    if (t === TILE_PLATFORM && y + 1 < map.getHeight() - 1) {
      const below = map.tileAt(x, y + 1);
      if (below === TILE_SOLID || below === TILE_PLATFORM) return false;
    }
    const above = map.tileAt(x, y - 1);
    return (
      above === TILE_EMPTY ||
      above === TILE_DOOR ||
      above === TILE_LADDER ||
      above === TILE_BREAKABLE ||
      above === TILE_PLATFORM
    );
  }

  function groundYFromMap(map) {
    const w = map.getWidth();
    const h = map.getHeight();
    const groundY = new Array(w);
    for (let x = 0; x < w; x++) {
      groundY[x] = h - 2;
      for (let y = h - 2; y >= 1; y--) {
        if (isFloorSurface(map, x, y)) {
          groundY[x] = y;
          break;
        }
      }
    }
    return groundY;
  }

  function isSupportedFromBelowOnGrid(grid, x, y, grounded) {
    if (y >= grid.length) return false;
    const below = grid[y][x];
    if (below === "-") {
      const under = y + 1;
      return under < grid.length && grounded[under][x];
    }
    if (isStackSolidChar(below)) return grounded[y][x];
    return false;
  }

  function removeFloatingSolidsOnGrid(grid, w, h) {
    if (w < 3 || h < 4) return;
    const grounded = Array.from({ length: h }, () => new Array(w).fill(false));
    for (let x = 0; x < w; x++) {
      if (isStackSolidChar(grid[h - 1][x])) grounded[h - 1][x] = true;
    }
    for (let y = h - 2; y >= 1; y--) {
      for (let x = 1; x < w - 1; x++) {
        if (!isStackSolidChar(grid[y][x])) continue;
        if (isSupportedFromBelowOnGrid(grid, x, y + 1, grounded)) grounded[y][x] = true;
      }
    }
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (!isStackSolidChar(grid[y][x]) || grounded[y][x]) continue;
        grid[y][x] = ".";
      }
    }
  }

  function stripPlatformsOneRowAbovePlayFloorOnGrid(grid, w, h, playFloorRow) {
    for (let tx = 1; tx < w - 1 && tx < playFloorRow.length; tx++) {
      const floor = playFloorRow[tx];
      if (floor < 2) continue;
      const deckRow = floor - 1;
      if (deckRow < 1 || deckRow >= h - 1) continue;
      if (grid[deckRow][tx] === "-") grid[deckRow][tx] = ".";
    }
  }

  function enforceOnGrid(grid, w, h, playFloorRow) {
    if (!grid || !playFloorRow) return;
    removeFloatingSolidsOnGrid(grid, w, h);
    stripPlatformsOneRowAbovePlayFloorOnGrid(grid, w, h, playFloorRow);
  }

  function seedGroundedFromBottomRow(map, w, h, grounded) {
    for (let x = 0; x < w; x++) {
      if (isStackSolid(map.tileAt(x, h - 1))) grounded[h - 1][x] = true;
    }
  }

  function isSupportedFromBelow(map, x, y, grounded) {
    if (y >= map.getHeight()) return false;
    const below = map.tileAt(x, y);
    if (below === TILE_PLATFORM) {
      const under = y + 1;
      return under < map.getHeight() && grounded[under][x];
    }
    if (isStackSolid(below)) return grounded[y][x];
    return false;
  }

  function removeFloatingSolids(map) {
    const w = map.getWidth();
    const h = map.getHeight();
    if (w < 3 || h < 4) return;
    const grounded = Array.from({ length: h }, () => new Array(w).fill(false));
    seedGroundedFromBottomRow(map, w, h, grounded);
    for (let y = h - 2; y >= 1; y--) {
      for (let x = 1; x < w - 1; x++) {
        if (!isStackSolid(map.tileAt(x, y))) continue;
        if (isSupportedFromBelow(map, x, y + 1, grounded)) grounded[y][x] = true;
      }
    }
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (map.tileAt(x, y) !== TILE_SOLID || grounded[y][x]) continue;
        map.setTile(x, y, TILE_EMPTY);
      }
    }
  }

  function stripPlatformsOneRowAbovePlayFloorOnMap(map, playFloorRow) {
    const w = map.getWidth();
    const h = map.getHeight();
    for (let tx = 1; tx < w - 1 && tx < playFloorRow.length; tx++) {
      const floor = playFloorRow[tx];
      if (floor < 2) continue;
      const deckRow = floor - 1;
      if (deckRow < 1 || deckRow >= h - 1) continue;
      if (map.isPlatformTile(tx, deckRow)) map.setTile(tx, deckRow, TILE_EMPTY);
    }
  }

  function enforceOnMap(map) {
    if (!map) return;
    removeFloatingSolids(map);
    stripPlatformsOneRowAbovePlayFloorOnMap(map, groundYFromMap(map));
  }

  function isStepColumnExcluded(x, leftDoorX, rightDoorX, ladderTx) {
    if (ladderTx >= 0 && x === ladderTx) return true;
    if (leftDoorX >= 0 && (x === leftDoorX || x === leftDoorX - 1 || x === leftDoorX + 1)) return true;
    if (rightDoorX >= 0 && (x === rightDoorX || x === rightDoorX - 1 || x === rightDoorX + 1)) return true;
    return false;
  }

  function hasLocalClimbInStepBand(map, floorX, floorN, x, nx) {
    const lo = Math.min(floorX, floorN);
    const hi = Math.max(floorX, floorN);
    const h = map.getHeight();
    for (let y = lo; y <= hi; y++) {
      if (y < 1 || y >= h - 1) continue;
      for (const col of [x, nx]) {
        const t = map.tileAt(col, y);
        if (t === TILE_LADDER || t === TILE_PLATFORM) return true;
      }
    }
    return false;
  }

  function hasTraversableClimbBetween(map, floor, x, nx, floorX, floorN) {
    if (floorX === floorN) return true;
    if (!hasLocalClimbInStepBand(map, floorX, floorN, x, nx)) return false;
    const lowCol = floorX > floorN ? x : nx;
    const highCol = floorX > floorN ? nx : x;
    const lowFeet = Math.max(floorX, floorN) - 1;
    const highFeet = Math.min(floorX, floorN) - 1;
    if (lowFeet < 1 || highFeet < 1) return false;
    if (!global.VernanBreakables?.canReachBetween) return false;
    return global.VernanBreakables.canReachBetween(
      map,
      floor,
      [[lowCol, lowFeet]],
      [[highCol, highFeet]]
    );
  }

  function shouldThinThreeHighInteriorPillar(seed, columnX, floorRow) {
    const mix = BigInt(seed >>> 0) ^ BigInt(columnX) * 0x9e3779b97n ^ BigInt(floorRow) * 0x85ebca6bn;
    return (mix & 3n) !== 0n;
  }

  function maxAllowedInteriorSolidRun(map, w, h, floor, x, pillarThinSeed, maxStep) {
    let maxRun = INTERIOR_PILLAR_DEFAULT_CAP;
    const f = floor[x];
    let maxNeighborStep = 0;
    for (const dx of [-1, 1]) {
      const nx = x + dx;
      if (nx < 1 || nx >= w - 1) continue;
      const step = Math.abs(f - floor[nx]);
      maxNeighborStep = Math.max(maxNeighborStep, step);
      if (step > maxStep) {
        if (hasTraversableClimbBetween(map, floor, x, nx, f, floor[nx])) {
          maxRun = Math.max(maxRun, step);
        } else {
          maxRun = Math.max(maxRun, maxStep);
        }
      } else {
        maxRun = Math.max(maxRun, step);
      }
    }
    maxRun = Math.max(1, maxRun);
    if (
      pillarThinSeed !== 0 &&
      maxStep >= MAX_STEP_HEIGHT &&
      maxRun >= MAX_STEP_HEIGHT &&
      maxNeighborStep === MAX_STEP_HEIGHT &&
      shouldThinThreeHighInteriorPillar(pillarThinSeed, x, f)
    ) {
      maxRun = INTERIOR_PILLAR_DEFAULT_CAP;
    }
    return maxRun;
  }

  function trimInteriorSolidsAboveFloor(
    map,
    w,
    h,
    floor,
    ladderTx,
    leftDoorX,
    rightDoorX,
    pillarThinSeed,
    maxStep
  ) {
    for (let x = 2; x < w - 2; x++) {
      if (isStepColumnExcluded(x, leftDoorX, rightDoorX, ladderTx)) continue;
      const maxAbove = maxAllowedInteriorSolidRun(map, w, h, floor, x, pillarThinSeed, maxStep);
      const f = floor[x];
      let above = 0;
      for (let y = f - 1; y >= 1; y--) {
        const t = map.tileAt(x, y);
        if (t !== TILE_SOLID && t !== TILE_BREAKABLE) break;
        above++;
        if (above > maxAbove && t !== TILE_BREAKABLE) {
          map.setTile(x, y, TILE_EMPTY);
        }
      }
    }
  }

  function isInteriorAir(map, x, y) {
    const t = map.tileAt(x, y);
    return t === TILE_EMPTY || t === TILE_LADDER;
  }

  function isInteriorAirInGap(map, gapStart, gapEnd, y) {
    for (let x = gapStart; x <= gapEnd; x++) {
      if (!isInteriorAir(map, x, y)) return false;
    }
    return true;
  }

  function isSolidFlank(map, x, y) {
    const t = map.tileAt(x, y);
    return t === TILE_SOLID || t === TILE_BREAKABLE;
  }

  function solidFlankHeightBesideGap(map, gapEdge, gapTop, gapBottom, side) {
    const col = gapEdge + side;
    let h = 0;
    for (let y = gapTop; y <= gapBottom; y++) {
      if (!isSolidFlank(map, col, y)) break;
      h++;
    }
    return h;
  }

  function tryClearOneTileGapFlank(map, col, y, leftDoorX, rightDoorX, ladderTx) {
    if (col < 1 || col >= map.getWidth() - 1) return false;
    if (isStepColumnExcluded(col, leftDoorX, rightDoorX, ladderTx)) return false;
    if (!isSolidFlank(map, col, y) || map.tileAt(col, y) === TILE_BREAKABLE) return false;
    map.setTile(col, y, TILE_EMPTY);
    return true;
  }

  function widenOneTileGapRow(map, gapX, y, leftDoorX, rightDoorX, ladderTx) {
    let clearedLeft = 0;
    let clearedRight = 0;
    while (1 + clearedLeft + clearedRight < MIN_INTERIOR_GAP_WIDTH) {
      let progressed = false;
      if (clearedLeft <= clearedRight) {
        if (tryClearOneTileGapFlank(map, gapX - clearedLeft - 1, y, leftDoorX, rightDoorX, ladderTx)) {
          clearedLeft++;
          progressed = true;
        }
      }
      if (1 + clearedLeft + clearedRight >= MIN_INTERIOR_GAP_WIDTH) break;
      if (clearedRight < clearedLeft || !progressed) {
        if (tryClearOneTileGapFlank(map, gapX + clearedRight + 1, y, leftDoorX, rightDoorX, ladderTx)) {
          clearedRight++;
          progressed = true;
        }
      }
      if (!progressed) break;
    }
  }

  function widenOneTileGapFullDepth(map, gapX, gapTop, gapBottom, leftDoorX, rightDoorX, ladderTx) {
    for (let y = gapTop; y <= gapBottom; y++) {
      widenOneTileGapRow(map, gapX, y, leftDoorX, rightDoorX, ladderTx);
    }
  }

  function widenTwoTileGapAtTop(map, gapStart, gapEnd, gapTop, leftDoorX, rightDoorX, ladderTx) {
    const innerLeft = gapStart - 1;
    const innerRight = gapEnd + 1;
    if (
      !isStepColumnExcluded(innerLeft, leftDoorX, rightDoorX, ladderTx) &&
      isSolidFlank(map, innerLeft, gapTop) &&
      map.tileAt(innerLeft, gapTop) !== TILE_BREAKABLE
    ) {
      map.setTile(innerLeft, gapTop, TILE_EMPTY);
      return;
    }
    if (
      !isStepColumnExcluded(innerRight, leftDoorX, rightDoorX, ladderTx) &&
      isSolidFlank(map, innerRight, gapTop) &&
      map.tileAt(innerRight, gapTop) !== TILE_BREAKABLE
    ) {
      map.setTile(innerRight, gapTop, TILE_EMPTY);
    }
  }

  function fixNarrowInteriorPits(map, w, h, ladderTx, leftDoorX, rightDoorX) {
    for (let y = 1; y < h - 1; y++) {
      let x = 2;
      while (x < w - 2) {
        if (!isInteriorAir(map, x, y)) {
          x++;
          continue;
        }
        const gapStart = x;
        while (x < w - 2 && isInteriorAir(map, x, y)) x++;
        const gapEnd = x - 1;
        const gapW = gapEnd - gapStart + 1;
        if (gapW !== 1 && gapW !== 2) continue;
        if (
          isStepColumnExcluded(gapStart, leftDoorX, rightDoorX, ladderTx) ||
          isStepColumnExcluded(gapEnd, leftDoorX, rightDoorX, ladderTx) ||
          isStepColumnExcluded(gapStart - 1, leftDoorX, rightDoorX, ladderTx) ||
          isStepColumnExcluded(gapEnd + 1, leftDoorX, rightDoorX, ladderTx)
        ) {
          continue;
        }
        if (!isSolidFlank(map, gapStart - 1, y) || !isSolidFlank(map, gapEnd + 1, y)) continue;
        let gapTop = y;
        let gapBottom = y;
        while (gapBottom < h - 2 && isInteriorAirInGap(map, gapStart, gapEnd, gapBottom + 1)) gapBottom++;
        const leftH = solidFlankHeightBesideGap(map, gapStart, gapTop, gapBottom, -1);
        const rightH = solidFlankHeightBesideGap(map, gapEnd, gapTop, gapBottom, 1);
        if (leftH < NARROW_GAP_MIN_FLANK_HEIGHT || rightH < NARROW_GAP_MIN_FLANK_HEIGHT) continue;
        if (gapW === 2) {
          widenTwoTileGapAtTop(map, gapStart, gapEnd, gapTop, leftDoorX, rightDoorX, ladderTx);
        } else {
          widenOneTileGapFullDepth(map, gapStart, gapTop, gapBottom, leftDoorX, rightDoorX, ladderTx);
        }
      }
    }
  }

  function capInteriorSolidPillarsOnMap(
    map,
    ladderTx,
    leftDoorX,
    rightDoorX,
    pillarThinSeed = 0,
    maxStep = MAX_STEP_HEIGHT
  ) {
    if (!map) return;
    const w = map.getWidth();
    const h = map.getHeight();
    const floor = groundYFromMap(map);
    trimInteriorSolidsAboveFloor(
      map,
      w,
      h,
      floor,
      ladderTx,
      leftDoorX,
      rightDoorX,
      pillarThinSeed,
      maxStep
    );
    fixNarrowInteriorPits(map, w, h, ladderTx, leftDoorX, rightDoorX);
  }

  function isGameplayPreservedTile(t) {
    return t === TILE_DOOR || t === TILE_LADDER;
  }

  function setColumnPlayFloorRow(map, x, floorRow) {
    const h = map.getHeight();
    for (let y = 1; y < h - 1; y++) {
      const t = map.tileAt(x, y);
      if (t === TILE_DOOR) continue;
      map.setTile(x, y, TILE_EMPTY);
    }
    for (let y = floorRow; y < h - 1; y++) {
      const t = map.tileAt(x, y);
      if (t === TILE_DOOR) continue;
      map.setTile(x, y, TILE_SOLID);
    }
  }

  function reseatColumnPlayFloor(map, x, newFloorRow, oldFloorRow) {
    if (newFloorRow === oldFloorRow) return;
    if (newFloorRow > oldFloorRow) {
      const h = map.getHeight();
      for (let y = oldFloorRow; y < newFloorRow; y++) {
        if (!isGameplayPreservedTile(map.tileAt(x, y))) map.setTile(x, y, TILE_EMPTY);
      }
      for (let y = newFloorRow; y < h - 1; y++) {
        const t = map.tileAt(x, y);
        if (isGameplayPreservedTile(t)) continue;
        if (t === TILE_EMPTY || t === TILE_LADDER) map.setTile(x, y, TILE_SOLID);
      }
      return;
    }
    setColumnPlayFloorRow(map, x, newFloorRow);
  }

  function enforceInteriorPlayFloorSteps(map, leftDoorX, rightDoorX, ladderTx, maxStep) {
    if (!map) return;
    const w = map.getWidth();
    const floor = groundYFromMap(map);
    for (let pass = 0; pass < w; pass++) {
      let changed = false;
      for (let x = 1; x < w - 2; x++) {
        const fa = floor[x];
        const fb = floor[x + 1];
        const step = Math.abs(fa - fb);
        if (step <= maxStep) continue;
        if (hasTraversableClimbBetween(map, floor, x, x + 1, fa, fb)) continue;
        if (fa < fb) {
          const target = fb - maxStep;
          if (!isStepColumnExcluded(x, leftDoorX, rightDoorX, ladderTx) && target > fa) {
            reseatColumnPlayFloor(map, x, target, fa);
            floor[x] = target;
            changed = true;
          } else if (!isStepColumnExcluded(x + 1, leftDoorX, rightDoorX, ladderTx)) {
            const raise = fa + maxStep;
            if (raise < fb) {
              reseatColumnPlayFloor(map, x + 1, raise, fb);
              floor[x + 1] = raise;
              changed = true;
            }
          }
        } else {
          const target = fa - maxStep;
          if (!isStepColumnExcluded(x + 1, leftDoorX, rightDoorX, ladderTx) && target > fb) {
            reseatColumnPlayFloor(map, x + 1, target, fb);
            floor[x + 1] = target;
            changed = true;
          } else if (!isStepColumnExcluded(x, leftDoorX, rightDoorX, ladderTx)) {
            const raise = fb + maxStep;
            if (raise < fa) {
              reseatColumnPlayFloor(map, x, raise, fa);
              floor[x] = raise;
              changed = true;
            }
          }
        }
      }
      if (!changed) break;
    }
  }

  function enforceTerrainRulesOnRoom(map, gen, maxStep, pillarThinSeed = 0) {
    if (!map || !gen) return;
    enforceOnMap(map);
    capInteriorSolidPillarsOnMap(
      map,
      gen.ladderColumnTx ?? -1,
      gen.leftDoorTileX ?? -1,
      gen.rightDoorTileX ?? -1,
      pillarThinSeed,
      maxStep
    );
    enforceInteriorPlayFloorSteps(
      map,
      gen.leftDoorTileX ?? -1,
      gen.rightDoorTileX ?? -1,
      gen.ladderColumnTx ?? -1,
      maxStep
    );
  }

  global.VernanTerrainRules = {
    enforceOnGrid,
    enforceOnMap,
    capInteriorSolidPillarsOnMap,
    enforceInteriorPlayFloorSteps,
    enforceTerrainRulesOnRoom,
    groundYFromMap,
    MAX_STEP_HEIGHT,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
