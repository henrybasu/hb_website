/**
 * Animated tile compositing (scanline warp, glow pulse, visual clips).
 * Port of Java TileRenderResolve + TileCompositeRenderer + TileWorldRenderer cache.
 */
(function (global) {
  "use strict";

  const GLOW_BLEED_PX = 8;
  const MAX_CACHE = 2048;

  function num(m, k, def) {
    const v = m?.[k];
    return typeof v === "number" ? v : def;
  }
  function bool(m, k, def) {
    const v = m?.[k];
    return typeof v === "boolean" ? v : def;
  }
  function str(m, k, def) {
    const v = m?.[k];
    return typeof v === "string" ? v : def;
  }
  function asList(v) {
    return Array.isArray(v) ? v : null;
  }
  function asMap(v) {
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  }

  function floorMod(a, b) {
    return ((a % b) + b) % b;
  }

  function glowDefaults() {
    return { scaleMin: 0.85, scaleMax: 1.2, scaleSpeed: 0.06, alphaBase: 180, alphaFlickerAmp: 55, alphaFlickerSpeed: 0.22, phaseRad: 0 };
  }

  function glowScaleAt(g, simTicks, phaseOffset) {
    const mid = (g.scaleMin + g.scaleMax) * 0.5;
    const half = (g.scaleMax - g.scaleMin) * 0.5;
    return mid + half * Math.sin(simTicks * g.scaleSpeed + g.phaseRad + phaseOffset);
  }

  function glowAlphaAt(g, simTicks, phaseOffset) {
    const p = simTicks * g.alphaFlickerSpeed + g.phaseRad * 1.7 + phaseOffset;
    const flicker = 0.6 * Math.sin(p) + 0.4 * Math.sin(p * 2.7 + 1.3);
    return Math.max(0, Math.min(255, Math.round(g.alphaBase + g.alphaFlickerAmp * flicker)));
  }

  function parseGlowPulse(raw) {
    const m = asMap(raw);
    if (!m || bool(m, "enabled", true) === false) return null;
    const d = glowDefaults();
    return {
      scaleMin: num(m, "scaleMin", d.scaleMin),
      scaleMax: num(m, "scaleMax", d.scaleMax),
      scaleSpeed: num(m, "scaleSpeedRadPerTick", d.scaleSpeed),
      alphaBase: num(m, "alphaBase", d.alphaBase),
      alphaFlickerAmp: num(m, "alphaFlickerAmp", d.alphaFlickerAmp),
      alphaFlickerSpeed: num(m, "alphaFlickerSpeedRadPerTick", d.alphaFlickerSpeed),
      phaseRad: num(m, "phaseRad", d.phaseRad),
    };
  }

  function parseScanlineWarp(raw, clipFrameIndex) {
    const m = asMap(raw);
    if (!m || bool(m, "enabled", true) === false) return null;
    return {
      ampPx: num(m, "ampPx", 1.2),
      strength: num(m, "strength", 1),
      phasePerRowRad: num(m, "phasePerRowRad", 0.52),
      timeRadPerSimTick: num(m, "timeRadPerSimTick", 0.033),
      clipFramePhaseRad: num(m, "clipFramePhaseRad", 0.33),
      pinnedRow: num(m, "pinnedRow", 0),
      clipFrameIndex,
    };
  }

  function layerHasAnim(layer) {
    const w = asMap(layer?.scanlineWarp);
    const g = asMap(layer?.glowPulse);
    if (w && bool(w, "enabled", true)) return true;
    if (g && bool(g, "enabled", true)) return true;
    return false;
  }

  function tileUsesAnimation(tileDef) {
    if (!tileDef) return false;
    if (asList(tileDef.visualClips)?.length) return true;
    for (const layer of asList(tileDef.renderLayers) || []) {
      if (layerHasAnim(layer)) return true;
    }
    for (const v of asList(tileDef.variations) || []) {
      for (const layer of asList(v.renderLayers) || []) {
        if (layerHasAnim(layer)) return true;
      }
    }
    return false;
  }

  function computeFrameIndex(clip, simTicks) {
    const tpf = Math.max(1, num(clip, "ticksPerFrame", 4));
    const frames = asList(clip.frames);
    const n = frames?.length ?? 0;
    if (n <= 0) return 0;
    const step = Math.floor(simTicks / tpf);
    if (bool(clip, "pingpong", false) && n > 1) {
      const period = Math.max(1, (n - 1) * 2);
      const u = floorMod(step, period);
      return u >= n ? period - u : u;
    }
    if (bool(clip, "loop", true)) return floorMod(step, n);
    return Math.min(Math.max(0, step), n - 1);
  }

  function clipAppliesToLayer(clip, layerId) {
    const applyTo = str(clip, "applyTo", "");
    if (applyTo === "allLayers") return true;
    const layerIds = asList(clip.layerIds);
    if (layerIds) {
      for (const o of layerIds) {
        if (layerId === String(o)) return true;
      }
    }
    const single = str(clip, "layerId", "");
    if (single) return single === layerId;
    return !applyTo && (!layerIds || !layerIds.length);
  }

  function applyKeyframeToLayer(layer, frame, layerId) {
    const ls = asMap(frame?.layerSprites);
    if (ls?.[layerId]) layer.sprite = JSON.parse(JSON.stringify(ls[layerId]));
    let ox = num(layer, "offsetXPx", 0);
    let oy = num(layer, "offsetYPx", 0);
    const lox = asMap(frame?.layerOffsetXPx);
    const loy = asMap(frame?.layerOffsetYPx);
    if (lox?.[layerId] != null) ox += Number(lox[layerId]) || 0;
    if (loy?.[layerId] != null) oy += Number(loy[layerId]) || 0;
    layer.offsetXPx = ox;
    layer.offsetYPx = oy;
    const rotMap = asMap(frame?.layerRotationMilliDeg);
    if (rotMap?.[layerId] != null) layer.rotationMilliDeg = Number(rotMap[layerId]) || 0;
  }

  function applyVisualPlayback(tile, stack, simTicks) {
    const clipsList = asList(tile.visualClips);
    if (!clipsList?.length) return;
    const clipsById = new Map();
    for (const c of clipsList) {
      const cm = asMap(c);
      const id = str(cm, "id", "");
      if (id) clipsById.set(id, cm);
    }
    if (!clipsById.size) return;
    const vp = asMap(tile.visualPlayback) || {};
    const overrides = asMap(vp.layerClipOverrides) || {};
    const defaultClipId = str(vp, "defaultClipId", "");

    for (const layer of stack) {
      const lid = str(layer, "layerId", "");
      const clipId = overrides[lid] ?? defaultClipId;
      if (!clipId) continue;
      const clip = clipsById.get(clipId);
      if (!clip || !clipAppliesToLayer(clip, lid)) continue;
      const frameIdx = computeFrameIndex(clip, simTicks);
      const frames = asList(clip.frames);
      const frame = asMap(frames?.[frameIdx]);
      if (!frame) continue;
      applyKeyframeToLayer(layer, frame, lid);
      layer._clipFrameIdx = frameIdx;
    }
  }

  function baseRenderLayers(tile, variationId) {
    if (variationId) {
      for (const vo of asList(tile.variations) || []) {
        const vm = asMap(vo);
        if (vm && vm.id === variationId) {
          const rl = asList(vm.renderLayers);
          if (rl?.length) return JSON.parse(JSON.stringify(rl));
          break;
        }
      }
    }
    const base = asList(tile.renderLayers);
    if (base?.length) return JSON.parse(JSON.stringify(base));
    return [];
  }

  function resolveLayers(tile, variationId, simTicks) {
    const stack = baseRenderLayers(tile, variationId);
    applyVisualPlayback(tile, stack, simTicks);
    const out = [];
    for (const layer of stack) {
      const sprite = asMap(layer.sprite);
      const cell = asMap(sprite?.cell);
      if (!sprite || !cell) continue;
      const clipFrame = layer._clipFrameIdx ?? 0;
      out.push({
        layerId: str(layer, "layerId", "base"),
        z: num(layer, "z", 0),
        sheetId: str(sprite, "sheetId", "main"),
        cellRow: num(cell, "row", 0),
        cellCol: num(cell, "col", 0),
        offsetXPx: num(layer, "offsetXPx", 0),
        offsetYPx: num(layer, "offsetYPx", 0),
        flipH: bool(layer, "flipH", false),
        flipV: bool(layer, "flipV", false),
        rotationMilliDeg: num(layer, "rotationMilliDeg", 0),
        opacity: num(layer, "opacity", 255),
        visible: bool(layer, "visible", true),
        blend: str(layer, "blend", "normal"),
        scanlineWarp: parseScanlineWarp(layer.scanlineWarp, clipFrame),
        glowPulse: parseGlowPulse(layer.glowPulse),
      });
    }
    out.sort((a, b) => a.z - b.z);
    return out;
  }

  function warpPhaseBucket(dstX, dstY, tileId) {
    let h = (BigInt(dstX) * 0x9e3779b97f4a7c15n) ^ (BigInt(dstY) * 0x85ebca6bn);
    if (tileId) {
      for (let i = 0; i < tileId.length; i++) {
        h = (h * 31n + BigInt(tileId.charCodeAt(i))) & ((1n << 64n) - 1n);
      }
    }
    return Number(h & 63n);
  }

  function warpPhaseOffsetFromBucket(bucket) {
    return (bucket / 64) * (Math.PI * 2);
  }

  function blitScanlineWarp(ctx, img, sx, sy, sw, sh, dx, dy, warp, phase) {
    const ref = Math.sin(phase);
    const amp = warp.ampPx * warp.strength;
    const pr = warp.phasePerRowRad;
    for (let row = 0; row < sh; row++) {
      const dr = row - warp.pinnedRow;
      const ox = amp * (Math.sin(phase + dr * pr) - ref);
      ctx.drawImage(img, sx, sy + row, sw, 1, Math.round(dx + ox), Math.round(dy + row), sw, 1);
    }
  }

  function drawLayerCell(ctx, img, tw, th, px, py, op, blend, glow, simTicks, phaseRad, warp) {
    if (op <= 0) return;
    const addBlend = blend.toLowerCase() === "add";
    const sx = 0;
    const sy = 0;

    if (glow == null && warp) {
      const phase =
        simTicks * warp.timeRadPerSimTick +
        warp.clipFrameIndex * warp.clipFramePhaseRad +
        phaseRad;
      ctx.save();
      ctx.globalAlpha = op / 255;
      if (addBlend) ctx.globalCompositeOperation = "lighter";
      blitScanlineWarp(ctx, img, sx, sy, tw, th, px, py, warp, phase);
      ctx.restore();
      return;
    }

    let scale = 1;
    let alpha = op;
    if (glow) {
      scale = glowScaleAt(glow, simTicks, phaseRad);
      alpha = glowAlphaAt(glow, simTicks, phaseRad);
      if (alpha <= 0) return;
    }

    const cx = px + tw * 0.5;
    const cy = py + th * 0.5;
    ctx.save();
    ctx.globalAlpha = alpha / 255;
    if (addBlend) ctx.globalCompositeOperation = "lighter";
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-tw * 0.5, -th * 0.5);
    if (glow == null && warp) {
      const phase =
        simTicks * warp.timeRadPerSimTick +
        warp.clipFrameIndex * warp.clipFramePhaseRad +
        phaseRad;
      blitScanlineWarp(ctx, img, sx, sy, tw, th, 0, 0, warp, phase);
    } else {
      ctx.drawImage(img, 0, 0, tw, th);
    }
    ctx.restore();
  }

  class TileAnimCache {
    constructor(maxSize = MAX_CACHE) {
      this.maxSize = maxSize;
      this.map = new Map();
    }

    get(key) {
      const v = this.map.get(key);
      if (v !== undefined) {
        this.map.delete(key);
        this.map.set(key, v);
      }
      return v;
    }

    set(key, value) {
      if (this.map.has(key)) this.map.delete(key);
      this.map.set(key, value);
      while (this.map.size > this.maxSize) {
        const first = this.map.keys().next().value;
        this.map.delete(first);
      }
    }

    clear() {
      this.map.clear();
    }
  }

  const globalCache = new TileAnimCache();

  function drawCachedTile(ctx, runtime, tileDef, tileId, dstX, dstY, simTicks, variationId = "") {
    const layers = resolveLayers(tileDef, variationId, simTicks);
    const warped = layers.some((L) => L.scanlineWarp);
    const glowing = layers.some((L) => L.glowPulse);
    const phaseAnimated = warped || glowing;
    const bucket = phaseAnimated ? warpPhaseBucket(dstX, dstY, tileId) : 0;
    const pad = glowing ? GLOW_BLEED_PX : 0;
    const key = phaseAnimated
      ? `${tileId}\0${variationId}\0${simTicks}\0w${bucket}`
      : `${tileId}\0${variationId}\0${simTicks}`;
    const phaseRad = phaseAnimated ? warpPhaseOffsetFromBucket(bucket) : 0;

    let entry = globalCache.get(key);
    if (!entry) {
      entry = composeTileFromLayers(runtime, layers, simTicks, pad, phaseRad);
      if (!entry?.canvas) return false;
      globalCache.set(key, entry);
    }
    try {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(entry.canvas, dstX - entry.pad, dstY - entry.pad);
      return true;
    } catch (_e) {
      return false;
    }
  }

  function composeTileFromLayers(runtime, layers, simTicks, pad, phaseRad) {
    let maxTw = 16;
    let maxTh = 16;
    for (const L of layers) {
      const sheet = runtime.sheets.get(L.sheetId);
      if (sheet) {
        maxTw = Math.max(maxTw, sheet.tileWidthPx);
        maxTh = Math.max(maxTh, sheet.tileHeightPx);
      }
    }
    const cw = maxTw + pad * 2;
    const ch = maxTh + pad * 2;
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    for (const L of layers) {
      if (!L.visible) continue;
      const sheet = runtime.sheets.get(L.sheetId);
      const img = sheet?.image;
      if (!img) continue;
      const tw = sheet.tileWidthPx;
      const th = sheet.tileHeightPx;
      const sx = L.cellCol * tw;
      const sy = L.cellRow * th;
      const cell = document.createElement("canvas");
      cell.width = tw;
      cell.height = th;
      const cc = cell.getContext("2d");
      cc.imageSmoothingEnabled = false;
      try {
        cc.drawImage(img, sx, sy, tw, th, 0, 0, tw, th);
      } catch (_e) {
        continue;
      }
      const px = pad + L.offsetXPx;
      const py = pad + L.offsetYPx;
      const op = L.glowPulse ? 255 : L.opacity;
      drawLayerCell(ctx, cell, tw, th, px, py, op, L.blend, L.glowPulse, simTicks, phaseRad, L.scanlineWarp);
    }
    return { canvas, pad };
  }

  global.VernanTileRender = {
    tileUsesAnimation,
    drawCachedTile,
    resolveLayers,
    clearCache: () => globalCache.clear(),
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
