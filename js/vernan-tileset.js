/**
 * Tileset v3 runtime for Vernan web (terrain bridge + member-graph autotile + layer compositing).
 * Ported from new-vernan-2 Java tileset pipeline (simplified: no glow/warp/deco overlays).
 */
(function (global) {
  "use strict";

  const TILE_EMPTY = 0;
  const TILE_SOLID = 1;
  const TILE_DOOR = 2;
  const TILE_PLATFORM = 3;
  const TILE_LADDER = 4;
  const TILE_BREAKABLE = 5;

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
  function asList(v) {
    return Array.isArray(v) ? v : null;
  }
  function asMap(v) {
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  }

  function terrainName(code) {
    return (
      {
        0: "EMPTY",
        1: "SOLID",
        2: "DOOR",
        3: "PLATFORM",
        4: "LADDER",
        5: "BREAKABLE",
        6: "KEYBLOCK",
        7: "KEYBLOCK_CONNECTOR",
      }[code] || ""
    );
  }

  function terrainCode(name) {
    const n = String(name || "").toUpperCase();
    return (
      {
        EMPTY: TILE_EMPTY,
        SOLID: TILE_SOLID,
        DOOR: TILE_DOOR,
        PLATFORM: TILE_PLATFORM,
        LADDER: TILE_LADDER,
        BREAKABLE: TILE_BREAKABLE,
        KEYBLOCK: 6,
        KEYBLOCK_CONNECTOR: 7,
      }[n] ?? -1
    );
  }

  function hashPick(seed, tx, ty, count) {
    if (count <= 0) return 0;
    let h = (seed ^ (tx * 374761393) ^ (ty * 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h >>> 0) % count;
  }

  class TerrainBridge {
    constructor() {
      this.choicesByTerrain = new Map();
      this.connectByTerrain = new Map();
      this.displayChoicesByRoomKind = new Map();
      this.connectAsTileIdByRoomKind = new Map();
    }

    static fromTilesetRoot(root) {
      const by = asMap(root?.terrainBridge)?.byTerrain;
      if (!by) return TerrainBridge.defaults();
      const out = new TerrainBridge();
      for (const [name, raw] of Object.entries(by)) {
        const code = terrainCode(name);
        if (code < 0) continue;
        const m = asMap(raw);
        if (!m) continue;
        out.choicesByTerrain.set(code, parseChoices(m.displayChoices));
        const connect = str(m, "connectAsTileId", "");
        if (connect) out.connectByTerrain.set(code, connect);
        const perKind = asMap(m.displayChoicesByRoomKind);
        if (perKind) {
          const kindMap = new Map();
          for (const [k, list] of Object.entries(perKind)) {
            kindMap.set(k.toUpperCase(), parseChoices(list));
          }
          out.displayChoicesByRoomKind.set(code, kindMap);
        }
        const connectPerKind = asMap(m.connectAsTileIdByRoomKind);
        if (connectPerKind) {
          const kindMap = new Map();
          for (const [k, v] of Object.entries(connectPerKind)) {
            if (typeof v === "string" && v) kindMap.set(k.toUpperCase(), v);
          }
          out.connectAsTileIdByRoomKind.set(code, kindMap);
        }
      }
      return out;
    }

    static defaults() {
      const out = new TerrainBridge();
      out.choicesByTerrain.set(TILE_SOLID, [{ tileId: "block", weight: 1 }]);
      out.connectByTerrain.set(TILE_SOLID, "block");
      return out;
    }

    displayTileIdForRoomKind(terrainInt, tx, ty, salt, roomKind, tileIdAllowed) {
      const kind = roomKind ? String(roomKind).toUpperCase() : null;
      if (kind) {
        const per = this.displayChoicesByRoomKind.get(terrainInt)?.get(kind);
        if (per?.length) {
          const picked = pickWeighted(terrainInt, tx, ty, salt, filterChoices(per, tileIdAllowed));
          if (picked) return picked;
          if (tileIdAllowed) {
            const retry = pickWeighted(terrainInt, tx, ty, salt, per);
            if (retry) return retry;
          }
        }
      }
      const fallback = filterChoices(this.choicesByTerrain.get(terrainInt), tileIdAllowed);
      let picked = pickWeighted(terrainInt, tx, ty, salt, fallback);
      if (!picked && tileIdAllowed) {
        picked = pickWeighted(terrainInt, tx, ty, salt, this.choicesByTerrain.get(terrainInt));
      }
      return picked;
    }

    connectTileIdForRoomKind(terrainInt, roomKind) {
      const kind = roomKind ? String(roomKind).toUpperCase() : null;
      if (kind) {
        const per = this.connectAsTileIdByRoomKind.get(terrainInt)?.get(kind);
        if (per) return per;
      }
      return this.connectByTerrain.get(terrainInt) || "";
    }

    displayTileIdForDoorIfPaired(map, tx, ty, salt, roomKind) {
      const kind = roomKind ? String(roomKind).toUpperCase() : null;
      let choices =
        (kind && this.displayChoicesByRoomKind.get(TILE_DOOR)?.get(kind)) ||
        this.choicesByTerrain.get(TILE_DOOR);
      if (!choices?.length) return null;
      if (choices.length >= 2 && choices.length % 2 === 0 && map) {
        const pairCount = choices.length / 2;
        const pairIndex = hashPick(salt ^ tx, tx, 0, pairCount);
        const topIdx = pairIndex * 2;
        const bottomIdx = topIdx + 1;
        if (ty + 1 < map.getHeight() && map.tileAt(tx, ty + 1) === TILE_DOOR) {
          return choices[topIdx].tileId;
        }
        if (ty - 1 >= 0 && map.tileAt(tx, ty - 1) === TILE_DOOR) {
          return choices[bottomIdx].tileId;
        }
      }
      return pickWeighted(TILE_DOOR, tx, ty, salt, choices);
    }
  }

  function parseChoices(raw) {
    const list = asList(raw);
    if (!list?.length) return [];
    const out = [];
    for (const item of list) {
      if (typeof item === "string" && item) out.push({ tileId: item, weight: 1 });
      else if (item && typeof item === "object") {
        const m = asMap(item);
        const tid = str(m, "tileId", "");
        if (!tid) continue;
        out.push({ tileId: tid, weight: Math.max(1, num(m, "weight", 1)) });
      }
    }
    return out;
  }

  function filterChoices(choices, allowed) {
    if (!choices?.length || !allowed) return choices;
    const out = choices.filter((c) => allowed(c.tileId));
    return out.length ? out : [];
  }

  function pickWeighted(terrainInt, tx, ty, salt, choices) {
    if (!choices?.length) return null;
    let total = 0;
    for (const c of choices) total += c.weight;
    if (total <= 0) return null;
    const useTy = terrainInt === TILE_LADDER ? 0 : ty;
    let roll = hashPick(salt ^ tx ^ useTy, tx, useTy, total);
    for (const c of choices) {
      if (roll < c.weight) return c.tileId;
      roll -= c.weight;
    }
    return choices[choices.length - 1].tileId;
  }

  function memberTileIdsOrdered(obj) {
    const ids = asList(obj?.tileIds);
    if (!ids?.length) return [];
    return ids.filter((x) => typeof x === "string" && x);
  }

  function findObjectRowOwningTileId(objects, tileId) {
    if (!tileId || !objects) return null;
    for (const raw of objects) {
      const obj = asMap(raw);
      if (!obj) continue;
      if (memberTileIdsOrdered(obj).includes(tileId)) return obj;
    }
    return null;
  }

  function parseLayoutCellPositions(cells, memberIds) {
    const allow = new Set(memberIds);
    const pos = new Map();
    for (const raw of cells || []) {
      const cm = asMap(raw);
      if (!cm) continue;
      const tid = str(cm, "tileId", "").trim();
      if (!tid || !allow.has(tid)) continue;
      const x = num(cm, "x", -1);
      const y = num(cm, "y", -1);
      if (x < 0 || y < 0) continue;
      pos.set(tid, { x, y });
    }
    return pos;
  }

  function resolveAnchorTileId(obj, layoutRoot, memberIds) {
    const cells = asList(layoutRoot?.cells);
    if (!cells?.length) return memberIds[0] || "";
    const pos = parseLayoutCellPositions(cells, memberIds);
    const onObj = str(obj, "anchorTileId", "").trim();
    if (onObj && pos.has(onObj)) return onObj;
    if (memberIds[0] && pos.has(memberIds[0])) return memberIds[0];
    let best = "";
    let bestY = Infinity;
    let bestX = Infinity;
    for (const [tid, p] of pos) {
      if (p.y < bestY || (p.y === bestY && p.x < bestX)) {
        best = tid;
        bestY = p.y;
        bestX = p.x;
      }
    }
    return best || memberIds[0] || "";
  }

  function footprintFromLayout(memberIds, layoutRoot, anchorTileId) {
    const cells = asList(layoutRoot?.cells);
    if (!cells?.length) return [{ tileId: anchorTileId, dTx: 0, dTy: 0 }];
    const pos = parseLayoutCellPositions(cells, memberIds);
    const ap = pos.get(anchorTileId);
    if (!ap) return [{ tileId: anchorTileId, dTx: 0, dTy: 0 }];
    const out = [];
    for (const [tid, p] of pos) {
      out.push({ tileId: tid, dTx: p.x - ap.x, dTy: p.y - ap.y });
    }
    return out.length ? out : [{ tileId: anchorTileId, dTx: 0, dTy: 0 }];
  }

  function fullObjectFootprint(memberIds, obj) {
    if (!memberIds?.length) return [];
    const layout = asMap(obj?.memberGraphLayout);
    if (!layout) return [{ tileId: memberIds[0], dTx: 0, dTy: 0 }];
    const anchor = resolveAnchorTileId(obj, layout, memberIds);
    return footprintFromLayout(memberIds, layout, anchor);
  }

  function memberGraphIslands(memberIds, obj) {
    const foot = fullObjectFootprint(memberIds, obj);
    if (foot.length <= 1) return [{ cells: foot, memberIds: foot.map((c) => c.tileId) }];
    const layout = asMap(obj?.memberGraphLayout);
    const cells = asList(layout?.cells);
    if (!cells?.length) return [{ cells: foot, memberIds: foot.map((c) => c.tileId) }];
    const gridPos = parseLayoutCellPositions(cells, memberIds);
    if (gridPos.size < 2) return [{ cells: foot, memberIds: foot.map((c) => c.tileId) }];
    const atCell = new Map();
    for (const [tid, p] of gridPos) atCell.set((p.y << 16) | (p.x & 0xffff), tid);
    const visited = new Set();
    const islands = [];
    const dx = [0, 1, 0, -1];
    const dy = [-1, 0, 1, 0];
    for (const seed of gridPos.keys()) {
      if (visited.has(seed)) continue;
      const component = new Set();
      const queue = [seed];
      visited.add(seed);
      while (queue.length) {
        const cur = queue.shift();
        component.add(cur);
        const p = gridPos.get(cur);
        if (!p) continue;
        for (let d = 0; d < 4; d++) {
          const nb = atCell.get(((p.y + dy[d]) << 16) | ((p.x + dx[d]) & 0xffff));
          if (!nb || visited.has(nb)) continue;
          visited.add(nb);
          queue.push(nb);
        }
      }
      const islandCells = foot.filter((c) => component.has(c.tileId));
      if (islandCells.length) {
        islands.push({ cells: islandCells, memberIds: islandCells.map((c) => c.tileId) });
      }
    }
    return islands.length ? islands : [{ cells: foot, memberIds: foot.map((c) => c.tileId) }];
  }

  function isHorizontalStrip(foot) {
    if (!foot?.length) return false;
    const ys = new Set(foot.map((c) => c.dTy));
    return ys.size === 1 && foot.length > 1;
  }

  function isVerticalStrip(foot) {
    if (!foot?.length) return false;
    const xs = new Set(foot.map((c) => c.dTx));
    return xs.size === 1 && foot.length > 1;
  }

  function autotileConnects(selfId, tileDef, neighborId) {
    if (!neighborId) return false;
    if (selfId === neighborId) return true;
    const at = asMap(tileDef?.autotile);
    if (!at) return false;
    const cw = asList(at.connectsWithTileIds);
    return cw ? cw.includes(neighborId) : false;
  }

  function stripConnects(selfId, neighborId, islandFoot, tileDefById) {
    if (!neighborId || !selfId || selfId === neighborId) return false;
    const selfCell = islandFoot.find((c) => c.tileId === selfId);
    if (!selfCell) return false;
    for (const c of islandFoot) {
      if (c.dTx === selfCell.dTx && c.dTy === selfCell.dTy - 1 && neighborId === c.tileId) return true;
      if (c.dTx === selfCell.dTx + 1 && c.dTy === selfCell.dTy && neighborId === c.tileId) return true;
      if (c.dTx === selfCell.dTx && c.dTy === selfCell.dTy + 1 && neighborId === c.tileId) return true;
      if (c.dTx === selfCell.dTx - 1 && c.dTy === selfCell.dTy && neighborId === c.tileId) return true;
    }
    const def = tileDefById(selfId);
    return def ? autotileConnects(selfId, def, neighborId) : false;
  }

  function scoreGridMember(islandFoot, n, e, s, w, tileDefById) {
    let bestId = null;
    let bestScore = -1;
    let bestExact = false;
    for (const cell of islandFoot) {
      const mid = cell.tileId;
      const def = tileDefById(mid);
      const hn = stripConnects(mid, n, islandFoot, tileDefById);
      const he = stripConnects(mid, e, islandFoot, tileDefById);
      const hs = stripConnects(mid, s, islandFoot, tileDefById);
      const hw = stripConnects(mid, w, islandFoot, tileDefById);
      const requireAll = bool(asMap(def?.autotile), "requireAllNeighbors", false);
      const requireNo = bool(asMap(def?.autotile), "requireNoNeighbors", false);
      const surrounded = n && hn && e && he && s && hs && w && hw;
      const isolated = (!n || !hn) && (!e || !he) && (!s || !hs) && (!w || !hw);
      if (requireAll && !surrounded) continue;
      if (requireNo && !isolated) continue;
      let score = 0;
      if (n && hn) score++;
      if (e && he) score++;
      if (s && hs) score++;
      if (w && hw) score++;
      const exact = (!n || hn) && (!e || he) && (!s || hs) && (!w || hw);
      if (exact && (!bestExact || score > bestScore)) {
        bestExact = true;
        bestScore = score;
        bestId = mid;
      } else if (!bestExact && score > bestScore) {
        bestScore = score;
        bestId = mid;
      }
    }
    return bestId;
  }

  function stackableTerrain(terrainCode) {
    return terrainCode === TILE_SOLID || terrainCode === TILE_BREAKABLE;
  }

  function makeMassContext(connectObj, bridge, salt, roomKind, tileIdAllowed) {
    if (!connectObj || str(connectObj, "objectType", "") !== "autotile") return null;
    return { objectRow: connectObj, bridge, displaySalt: salt, roomKind, tileIdAllowed };
  }

  function terrainConnectsMass(map, tx, ty, terrainCode, massCtx, objects, bridge, salt, roomKind) {
    if (tx < 0 || ty < 0 || tx >= map.getWidth() || ty >= map.getHeight()) return false;
    if (map.tileAt(tx, ty) !== terrainCode) return false;
    if (!massCtx?.objectRow || !massCtx.bridge || !objects) return true;
    const neighborPick = massCtx.bridge.displayTileIdForRoomKind(
      terrainCode,
      tx,
      ty,
      massCtx.displaySalt,
      massCtx.roomKind,
      massCtx.tileIdAllowed
    );
    return sameAutotilePackage(massCtx.objectRow, neighborPick, objects);
  }

  function terrainConnectNeighborId(
    map,
    ntx,
    nty,
    terrainCode,
    connectId,
    massCtx,
    objects,
    bridge,
    salt,
    roomKind
  ) {
    if (!connectId || !terrainConnectsMass(map, ntx, nty, terrainCode, massCtx, objects, bridge, salt, roomKind)) {
      return "";
    }
    if (!massCtx?.objectRow || !massCtx.bridge) return connectId;
    const neighborPick = massCtx.bridge.displayTileIdForRoomKind(
      terrainCode,
      ntx,
      nty,
      massCtx.displaySalt,
      massCtx.roomKind,
      massCtx.tileIdAllowed
    );
    if (!neighborPick || !sameAutotilePackage(massCtx.objectRow, neighborPick, objects)) return "";
    return neighborPick.trim();
  }

  function orthoTerrainConnectNeighbors(
    map,
    tx,
    ty,
    terrainCode,
    connectId,
    massCtx,
    objects,
    bridge,
    salt,
    roomKind
  ) {
    return {
      n: terrainConnectNeighborId(map, tx, ty - 1, terrainCode, connectId, massCtx, objects, bridge, salt, roomKind),
      e: terrainConnectNeighborId(map, tx + 1, ty, terrainCode, connectId, massCtx, objects, bridge, salt, roomKind),
      s: terrainConnectNeighborId(map, tx, ty + 1, terrainCode, connectId, massCtx, objects, bridge, salt, roomKind),
      w: terrainConnectNeighborId(map, tx - 1, ty, terrainCode, connectId, massCtx, objects, bridge, salt, roomKind),
    };
  }

  function horizontalRunLength(map, tx, ty, terrainCode, massCtx, objects, bridge, salt, roomKind) {
    let runStart = tx;
    while (
      runStart > 0 &&
      terrainConnectsMass(map, runStart - 1, ty, terrainCode, massCtx, objects, bridge, salt, roomKind)
    ) {
      runStart--;
    }
    let runEnd = tx;
    while (
      runEnd < map.getWidth() - 1 &&
      terrainConnectsMass(map, runEnd + 1, ty, terrainCode, massCtx, objects, bridge, salt, roomKind)
    ) {
      runEnd++;
    }
    return runEnd - runStart + 1;
  }

  function verticalRunLength(map, tx, ty, terrainCode, massCtx, objects, bridge, salt, roomKind) {
    let runStart = ty;
    while (
      runStart > 0 &&
      terrainConnectsMass(map, tx, runStart - 1, terrainCode, massCtx, objects, bridge, salt, roomKind)
    ) {
      runStart--;
    }
    let runEnd = ty;
    while (
      runEnd < map.getHeight() - 1 &&
      terrainConnectsMass(map, tx, runEnd + 1, terrainCode, massCtx, objects, bridge, salt, roomKind)
    ) {
      runEnd++;
    }
    return runEnd - runStart + 1;
  }

  function stripMemberForRunIndex(sorted, indexInRun, runLen) {
    const n = sorted.length;
    if (n === 0 || runLen <= 0 || indexInRun < 0 || indexInRun >= runLen) return sorted[0] || "";
    if (runLen === 1) return sorted[0];
    if (indexInRun === 0) return sorted[0];
    if (indexInRun === runLen - 1) return sorted[n - 1];
    if (n <= 2) return sorted[Math.min(indexInRun, n - 1)];
    const innerSlots = n - 2;
    const innerPos = 1 + Math.floor(((indexInRun - 1) * innerSlots) / Math.max(1, runLen - 2));
    return sorted[Math.min(n - 2, Math.max(1, innerPos))];
  }

  function pickFromTerrainRun(
    map,
    tx,
    ty,
    terrainCode,
    sorted,
    horizontal,
    massCtx,
    objects,
    bridge,
    salt,
    roomKind
  ) {
    const runLen = horizontal
      ? horizontalRunLength(map, tx, ty, terrainCode, massCtx, objects, bridge, salt, roomKind)
      : verticalRunLength(map, tx, ty, terrainCode, massCtx, objects, bridge, salt, roomKind);
    if (runLen <= 1) return null;
    let runStart;
    let indexInRun;
    if (horizontal) {
      runStart = tx;
      while (
        runStart > 0 &&
        terrainConnectsMass(map, runStart - 1, ty, terrainCode, massCtx, objects, bridge, salt, roomKind)
      ) {
        runStart--;
      }
      indexInRun = tx - runStart;
    } else {
      runStart = ty;
      while (
        runStart > 0 &&
        terrainConnectsMass(map, tx, runStart - 1, terrainCode, massCtx, objects, bridge, salt, roomKind)
      ) {
        runStart--;
      }
      indexInRun = ty - runStart;
    }
    return stripMemberForRunIndex(sorted, indexInRun, runLen);
  }

  function sortedStripMembers(foot, horizontal) {
    const copy = foot.slice();
    copy.sort((a, b) => (horizontal ? a.dTx - b.dTx : a.dTy - b.dTy));
    return copy.map((c) => c.tileId);
  }

  function pickHorizontalStrip(sorted, e, w, islandFoot, tileDefById) {
    for (const tid of sorted) {
      if (stripConnects(tid, e, islandFoot, tileDefById) || stripConnects(tid, w, islandFoot, tileDefById)) {
        return tid;
      }
    }
    return sorted[0];
  }

  function pickVerticalStrip(sorted, n, s, islandFoot, tileDefById) {
    for (const tid of sorted) {
      if (stripConnects(tid, n, islandFoot, tileDefById) || stripConnects(tid, s, islandFoot, tileDefById)) {
        return tid;
      }
    }
    return sorted[0];
  }

  function resolveForIsland(
    island,
    pooledId,
    n,
    e,
    s,
    w,
    tileDefById,
    map,
    tx,
    ty,
    terrainCode,
    massCtx,
    objects,
    bridge,
    salt,
    roomKind
  ) {
    const foot = island.cells;
    if (!foot.length) return null;
    if (foot.length === 1) return foot[0].tileId;
    const horizontal = isHorizontalStrip(foot);
    const vertical = !horizontal && isVerticalStrip(foot);
    const sorted = sortedStripMembers(foot, horizontal);
    if (
      map &&
      tx >= 0 &&
      ty >= 0 &&
      stackableTerrain(terrainCode) &&
      (horizontal || vertical)
    ) {
      const fromRun = pickFromTerrainRun(
        map,
        tx,
        ty,
        terrainCode,
        sorted,
        horizontal,
        massCtx,
        objects,
        bridge,
        salt,
        roomKind
      );
      if (fromRun) return fromRun;
    }
    if (horizontal) return pickHorizontalStrip(sorted, e, w, foot, tileDefById);
    if (vertical) return pickVerticalStrip(sorted, n, s, foot, tileDefById);
    return scoreGridMember(foot, n, e, s, w, tileDefById) || pooledId;
  }

  function objectOwnsTile(obj, tileId) {
    if (!obj || !tileId) return false;
    if (memberTileIdsOrdered(obj).includes(tileId)) return true;
    const layout = asMap(obj.memberGraphLayout);
    const cells = asList(layout?.cells);
    if (!cells) return false;
    for (const raw of cells) {
      if (str(asMap(raw), "tileId", "") === tileId) return true;
    }
    return false;
  }

  function sameAutotilePackage(selfObj, neighborId, objects) {
    if (!selfObj || !neighborId) return false;
    const pick = neighborId.trim();
    const neighborObj = findObjectRowOwningTileId(objects, pick);
    if (neighborObj) return str(selfObj, "id", "") === str(neighborObj, "id", "");
    return objectOwnsTile(selfObj, pick);
  }

  function pickBelongsToConnectObject(connectObj, displayId, objects) {
    if (!connectObj || !displayId) return false;
    if (objectOwnsTile(connectObj, displayId)) return true;
    const owner = findObjectRowOwningTileId(objects, displayId);
    return owner != null && str(owner, "id", "") === str(connectObj, "id", "");
  }

  function resolveTerrainDisplayTileId(
    pooledId,
    n,
    e,
    s,
    w,
    objects,
    tileDefById,
    connectObj,
    map,
    tx,
    ty,
    terrainCode,
    massCtx,
    bridge,
    salt,
    roomKind
  ) {
    if (!pooledId || !objects) return pooledId;
    let obj = findObjectRowOwningTileId(objects, pooledId);
    if (!obj && connectObj && pickBelongsToConnectObject(connectObj, pooledId, objects)) {
      obj = connectObj;
    }
    if (!obj || str(obj, "objectType", "") !== "autotile") return pooledId;
    const members = memberTileIdsOrdered(obj);
    if (members.length < 2) return pooledId;
    const islands = memberGraphIslands(members, obj);
    let bestId = null;
    let bestScore = -1;
    let bestExact = false;
    for (const island of islands) {
      const picked = resolveForIsland(
        island,
        pooledId,
        n || "",
        e || "",
        s || "",
        w || "",
        tileDefById,
        map,
        tx,
        ty,
        terrainCode,
        massCtx,
        objects,
        bridge,
        salt,
        roomKind
      );
      if (!picked) continue;
      const scored = scoreGridMember(island.cells, n || "", e || "", s || "", w || "", tileDefById);
      const exact = scored === picked;
      const score = exact ? 4 : 1;
      if (exact && (!bestExact || score > bestScore)) {
        bestExact = true;
        bestScore = score;
        bestId = picked;
      } else if (!bestExact && score > bestScore) {
        bestScore = score;
        bestId = picked;
      }
    }
    return bestId || pooledId;
  }

  function proceduralDecoSolidOrBreakableBelow(map, tx, ty) {
    const b = ty + 1;
    if (b >= map.getHeight()) return false;
    const below = map.tileAt(tx, b);
    return below === TILE_SOLID || below === TILE_BREAKABLE;
  }

  function tileAllowedInRoomKind(tileDef, roomKind) {
    if (!tileDef || !roomKind) return true;
    const rs = asMap(tileDef.roomScope);
    const allow = asList(rs?.allowRoomKinds);
    if (!allow?.length) return true;
    return allow.map((x) => String(x).toUpperCase()).includes(String(roomKind).toUpperCase());
  }

  function bridgeDisplayTileId(map, tx, ty, terrainCode, bridge, salt, roomKind) {
    if (terrainCode === TILE_EMPTY) {
      if (!proceduralDecoSolidOrBreakableBelow(map, tx, ty)) return null;
      return bridge.displayTileIdForRoomKind(TILE_EMPTY, tx, ty, salt, roomKind, null) || "grass";
    }
    if (terrainCode === TILE_DOOR) {
      return bridge.displayTileIdForDoorIfPaired(map, tx, ty, salt, roomKind);
    }
    return bridge.displayTileIdForRoomKind(terrainCode, tx, ty, salt, roomKind, (id) => {
      const def = runtimeRef?.tileById(id);
      return !def || tileAllowedInRoomKind(def, roomKind);
    });
  }

  function resolveTerrainCell(map, tx, ty, terrainCode, bridge, salt, roomKind, objects, tileDefById) {
    const tileIdAllowed = (id) => {
      const def = tileDefById(id);
      return !def || tileAllowedInRoomKind(def, roomKind);
    };
    const displayId = bridgeDisplayTileId(map, tx, ty, terrainCode, bridge, salt, roomKind);
    if (!displayId) return null;
    const connectId = bridge.connectTileIdForRoomKind(terrainCode, roomKind);
    const connectObj = connectId ? findObjectRowOwningTileId(objects, connectId) : null;
    const massCtx = makeMassContext(connectObj, bridge, salt, roomKind, tileIdAllowed);
    if (
      connectObj &&
      str(connectObj, "objectType", "") === "autotile" &&
      pickBelongsToConnectObject(connectObj, displayId, objects)
    ) {
      const anchor = connectId;
      const nb = orthoTerrainConnectNeighbors(
        map,
        tx,
        ty,
        terrainCode,
        anchor,
        massCtx,
        objects,
        bridge,
        salt,
        roomKind
      );
      const resolved = resolveTerrainDisplayTileId(
        anchor,
        nb.n,
        nb.e,
        nb.s,
        nb.w,
        objects,
        tileDefById,
        connectObj,
        map,
        tx,
        ty,
        terrainCode,
        massCtx,
        bridge,
        salt,
        roomKind
      );
      return resolved || displayId;
    }
    return displayId;
  }

  let runtimeRef = null;

  function normalizeSheetPath(imagePath, assetBase) {
    if (!imagePath) return "";
    if (imagePath.includes("la sheet.png")) return "tiles/la sheet.png";
    if (imagePath.startsWith("tiles/")) return imagePath;
    const idx = imagePath.lastIndexOf("tiles/");
    if (idx >= 0) return imagePath.slice(idx);
    return "tiles/" + imagePath.replace(/^.*[\\/]/, "");
  }

  class TilesetRuntime {
    constructor(root, sheets, images, bridge) {
      this.root = root;
      this.sheets = sheets;
      this.images = images;
      this.bridge = bridge;
      this.tilesById = new Map();
      this.objects = asList(root.objects) || [];
      for (const raw of asList(root.tiles) || []) {
        const t = asMap(raw);
        const id = str(t, "id", "");
        if (id) this.tilesById.set(id, t);
      }
      runtimeRef = this;
    }

    tileById(id) {
      return id ? this.tilesById.get(id) : null;
    }

    static async load(assetBase, loadImage) {
      const jsonUrl = new URL("tileset/tileset.json", assetBase).href;
      const res = await fetch(jsonUrl);
      if (!res.ok) throw new Error("Failed to load tileset.json");
      const root = await res.json();
      const bridge = TerrainBridge.fromTilesetRoot(root);
      const sheets = new Map();
      const images = new Map();
      for (const raw of asList(root.sheets) || []) {
        const s = asMap(raw);
        const id = str(s, "id", "");
        const rel = normalizeSheetPath(str(s, "imagePath", ""), assetBase);
        if (!id || !rel) continue;
        try {
          const img = await loadImage(rel);
          sheets.set(id, {
            id,
            image: img,
            tileWidthPx: num(s, "tileWidthPx", 16),
            tileHeightPx: num(s, "tileHeightPx", 16),
          });
          images.set(rel, img);
        } catch (err) {
          console.warn("[Vernan] tileset sheet failed to load:", rel, err);
        }
      }
      if (!sheets.has("main")) {
        throw new Error("tileset main sheet missing");
      }
      return new TilesetRuntime(root, sheets, images, bridge);
    }

    drawTile(ctx, tileId, dstX, dstY) {
      const def = this.tileById(tileId);
      if (!def) return false;
      const layers = asList(def.renderLayers);
      if (!layers?.length) return false;
      const sorted = layers
        .map((raw) => asMap(raw))
        .filter(Boolean)
        .sort((a, b) => num(a, "z", 0) - num(b, "z", 0));
      let drew = false;
      for (const layer of sorted) {
        if (bool(layer, "visible", true) === false) continue;
        const sprite = asMap(layer.sprite);
        const sheetId = str(sprite, "sheetId", "");
        const cell = asMap(sprite?.cell);
        const sheet = this.sheets.get(sheetId);
        const img = sheet?.image;
        if (!img) continue;
        const col = num(cell, "col", 0);
        const row = num(cell, "row", 0);
        const tw = sheet.tileWidthPx;
        const th = sheet.tileHeightPx;
        const sx = col * tw;
        const sy = row * th;
        const op = num(layer, "opacity", 255);
        if (op <= 0) continue;
        const dx = dstX + num(layer, "offsetXPx", 0);
        const dy = dstY + num(layer, "offsetYPx", 0);
        ctx.save();
        if (op < 255) ctx.globalAlpha = op / 255;
        if (bool(layer, "flipH", false) || bool(layer, "flipV", false)) {
          ctx.translate(dx + (bool(layer, "flipH", false) ? tw : 0), dy + (bool(layer, "flipV", false) ? th : 0));
          ctx.scale(bool(layer, "flipH", false) ? -1 : 1, bool(layer, "flipV", false) ? -1 : 1);
          try {
            ctx.drawImage(img, sx, sy, tw, th, 0, 0, tw, th);
            drew = true;
          } catch (_e) {
            ctx.restore();
            continue;
          }
        } else {
          try {
            ctx.drawImage(img, sx, sy, tw, th, dx, dy, tw, th);
            drew = true;
          } catch (_e) {
            ctx.restore();
            continue;
          }
        }
        ctx.restore();
      }
      return drew;
    }

    drawRoom(ctx, map, opts) {
      const {
        roomKind = "NORMAL",
        displaySalt = 0,
        x0 = 0,
        y0 = 0,
        x1 = map.getWidth() - 1,
        y1 = map.getHeight() - 1,
      } = opts || {};
      const tileDefById = (id) => this.tileById(id);
      let drawn = 0;
      const kind = String(roomKind || "").toUpperCase();
      const skipGrassUnderlay = kind === "SECRET" || kind === "SUPER_SECRET";
      // Pass 1: background grass / empty underlay above solid
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const t = map.tileAt(tx, ty);
          if (t === TILE_SOLID || t === TILE_BREAKABLE || t === TILE_DOOR) continue;
          if (t === TILE_LADDER || t === TILE_PLATFORM) continue;
          if (t !== TILE_EMPTY) continue;
          if (skipGrassUnderlay) continue;
          if (!proceduralDecoSolidOrBreakableBelow(map, tx, ty)) continue;
          const tileId = resolveTerrainCell(
            map,
            tx,
            ty,
            TILE_EMPTY,
            this.bridge,
            displaySalt,
            roomKind,
            this.objects,
            tileDefById
          );
          if (tileId && this.drawTile(ctx, tileId, tx * 16, ty * 16)) drawn++;
        }
      }
      // Pass 2: solids, breakables, platforms, ladders, doors
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const t = map.tileAt(tx, ty);
          if (
            t !== TILE_SOLID &&
            t !== TILE_BREAKABLE &&
            t !== TILE_PLATFORM &&
            t !== TILE_LADDER &&
            t !== TILE_DOOR
          ) {
            continue;
          }
          const tileId = resolveTerrainCell(
            map,
            tx,
            ty,
            t,
            this.bridge,
            displaySalt,
            roomKind,
            this.objects,
            tileDefById
          );
          if (tileId && this.drawTile(ctx, tileId, tx * 16, ty * 16)) drawn++;
        }
      }
      return drawn;
    }
  }

  global.VernanTileset = {
    TilesetRuntime,
    TerrainBridge,
    proceduralDecoSolidOrBreakableBelow,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
