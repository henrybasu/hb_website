/**
 * Earthbound-style room math backgrounds (port of BackgroundRendererV3 + BackgroundPresetRegistry).
 */
(function (global) {
  "use strict";

  const VIEWPORT_W = 512;
  const VIEWPORT_H = 256;
  const BOSS_PRESET_PICK_SALT = 0xb055b46c47524f4fn;
  const SECRET_PRESET_PICK_SALT = 0x5ec847b427220a95n;
  const BOSS_IDS = ["boss0", "boss1", "boss2", "boss3", "boss4", "boss5", "boss6"];
  const SECRET_IDS = ["secret0", "secret1", "secret2", "secret3", "secret4"];

  function num(o, k, def) {
    const v = o?.[k];
    return typeof v === "number" && Number.isFinite(v) ? v : def;
  }

  function bool(o, k, def) {
    const v = o?.[k];
    return typeof v === "boolean" ? v : def;
  }

  function str(o, k, def) {
    const v = o?.[k];
    return typeof v === "string" ? v : def;
  }

  function floorDiv(a, b) {
    return Math.floor(a / b);
  }

  function floorMod(a, b) {
    return ((a % b) + b) % b;
  }

  function detectFrameCount(img) {
    if (!img) return 1;
    const w = img.width;
    const h = img.height;
    if (h <= 0 || w < h || w % h !== 0) return 1;
    return w / h;
  }

  function detectFrameWidth(img) {
    const fc = detectFrameCount(img);
    return !img || fc <= 0 ? 16 : img.width / fc;
  }

  function detectFrameHeight(img) {
    return img?.height ?? 16;
  }

  function defaultPhaseOffset(layerIndex) {
    return layerIndex * 2.399963229728653;
  }

  function normalizeBlend(mode) {
    if (!mode) return "normal";
    const m = mode.toLowerCase();
    if (m === "darker") return "darken";
    if (m === "brighter") return "lighten";
    return m;
  }

  function lerp(a, b, t) {
    return Math.round(a + (b - a) * t);
  }

  function clampAdd(base, add, fa) {
    return Math.min(255, base + Math.round(add * fa));
  }

  function overlayChannel(base, blend) {
    return base < 128 ? (2 * base * blend) / 255 : 255 - (2 * (255 - base) * (255 - blend)) / 255;
  }

  function blendPixel(dest, src, globalOpacity, mode) {
    const sa0 = (src >>> 24) & 255;
    if (sa0 === 0 || globalOpacity <= 0) return dest;
    const sa = Math.round(sa0 * globalOpacity);
    if (sa === 0) return dest;
    const sr = (src >> 16) & 255;
    const sg = (src >> 8) & 255;
    const sb = src & 255;
    const dr = (dest >> 16) & 255;
    const dg = (dest >> 8) & 255;
    const db = dest & 255;
    const da = (dest >>> 24) & 255;
    const fa = sa / 255;
    let nr, ng, nb;
    switch (normalizeBlend(mode)) {
      case "add":
        nr = clampAdd(dr, sr, fa);
        ng = clampAdd(dg, sg, fa);
        nb = clampAdd(db, sb, fa);
        break;
      case "multiply":
        nr = lerp(dr, (dr * sr) / 255, fa);
        ng = lerp(dg, (dg * sg) / 255, fa);
        nb = lerp(db, (db * sb) / 255, fa);
        break;
      case "screen":
        nr = lerp(dr, 255 - ((255 - dr) * (255 - sr)) / 255, fa);
        ng = lerp(dg, 255 - ((255 - dg) * (255 - sg)) / 255, fa);
        nb = lerp(db, 255 - ((255 - db) * (255 - sb)) / 255, fa);
        break;
      case "overlay":
        nr = lerp(dr, overlayChannel(dr, sr), fa);
        ng = lerp(dg, overlayChannel(dg, sg), fa);
        nb = lerp(db, overlayChannel(db, sb), fa);
        break;
      case "darken":
        nr = lerp(dr, Math.min(dr, sr), fa);
        ng = lerp(dg, Math.min(dg, sg), fa);
        nb = lerp(db, Math.min(db, sb), fa);
        break;
      case "lighten":
        nr = lerp(dr, Math.max(dr, sr), fa);
        ng = lerp(dg, Math.max(dg, sg), fa);
        nb = lerp(db, Math.max(db, sb), fa);
        break;
      default:
        nr = lerp(dr, sr, fa);
        ng = lerp(dg, sg, fa);
        nb = lerp(db, sb, fa);
    }
    const na = Math.min(255, Math.max(0, sa + Math.round((da * (255 - sa)) / 255)));
    return (na << 24) | (nr << 16) | (ng << 8) | nb;
  }

  function compositeOnto(dest, src, w, h, blend, opacity, skipMask) {
    const go = Math.max(0, Math.min(1, opacity));
    const count = w * h;
    for (let i = 0; i < count; i++) {
      if (skipMask && skipMask[i]) continue;
      dest[i] = blendPixel(dest[i], src[i], go, blend);
    }
  }

  function readSpritePixels(img) {
    if (img.__vernanSpritePx) return img.__vernanSpritePx;
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const data = cx.getImageData(0, 0, c.width, c.height).data;
    const out = new Uint32Array(c.width * c.height);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      out[i] = (data[j + 3] << 24) | (data[j] << 16) | (data[j + 1] << 8) | data[j + 2];
    }
    img.__vernanSpritePx = out;
    return out;
  }

  function pickFrame(layer, tileX, tileY, simTick) {
    const { frameMode, frameIndex, frameCount, animateFrames, animateTicksPerFrame, animateLoop } = layer;
    if (frameMode === "checkerboard" && frameCount >= 2) {
      return (floorMod(tileX, 2) + floorMod(tileY, 2)) & 1;
    }
    if (frameMode === "animate" && animateFrames?.length) {
      const tpf = Math.max(1, animateTicksPerFrame);
      let step = Math.floor(simTick / tpf);
      if (!animateLoop) step = Math.min(step, animateFrames.length - 1);
      else step = floorMod(step, animateFrames.length);
      return Math.max(0, Math.min(frameCount - 1, animateFrames[step]));
    }
    return Math.max(0, Math.min(frameCount - 1, frameIndex));
  }

  function parseDistortion(tr, layerIndex) {
    if (!bool(tr, "enabled", true)) return null;
    const kind = str(tr, "kind", "").toLowerCase();
    const phase = defaultPhaseOffset(layerIndex);
    if (kind === "scanlinewarp" || kind === "scanlineWarp") {
      return {
        kind: "scanline",
        ampPx: num(tr, "ampPx", 2.5),
        strength: num(tr, "strength", 1),
        phasePerRowRad: num(tr, "phasePerRowRad", 0.4),
        timeRadPerTick: num(tr, "timeRadPerTick", 0.05),
        pinnedRow: num(tr, "pinnedRow", 8),
        phaseOffsetRad: num(tr, "phaseOffsetRad", phase),
      };
    }
    if (kind === "wave2d" || kind === "wave") {
      return {
        kind: "wave2d",
        ampXPx: num(tr, "ampXPx", 1),
        ampYPx: num(tr, "ampYPx", 0.5),
        phasePerColRad: num(tr, "phasePerColRad", 0.15),
        phasePerRowRad: num(tr, "phasePerRowRad", 0.55),
        pinnedCol: num(tr, "pinnedCol", 0),
        pinnedRow: num(tr, "pinnedRow", 8),
        timeRadPerTick: num(tr, "timeRadPerTick", 0.01),
        phaseOffsetRad: num(tr, "phaseOffsetRad", phase),
      };
    }
    if (kind === "ripple") {
      return {
        kind: "ripple",
        centerXPx: num(tr, "centerXPx", VIEWPORT_W * 0.5),
        centerYPx: num(tr, "centerYPx", VIEWPORT_H * 0.5),
        radiusPx: num(tr, "radiusPx", Math.hypot(VIEWPORT_W, VIEWPORT_H) * 0.55),
        ampPx: num(tr, "ampPx", 3),
        rings: num(tr, "rings", 3),
        timeRadPerTick: num(tr, "timeRadPerTick", 0.06),
        phaseOffsetRad: num(tr, "phaseOffsetRad", phase),
      };
    }
    if (kind === "fisheye") {
      return {
        kind: "fisheye",
        centerXPx: num(tr, "centerXPx", VIEWPORT_W * 0.5),
        centerYPx: num(tr, "centerYPx", VIEWPORT_H * 0.5),
        radiusPx: num(tr, "radiusPx", Math.hypot(VIEWPORT_W, VIEWPORT_H) * 0.55),
        strength: num(tr, "strength", 0.35),
        rippleAmp: num(tr, "rippleAmp", 0.12),
        rippleFreq: num(tr, "rippleFreq", 4),
        timeRadPerTick: num(tr, "timeRadPerTick", 0.04),
        phaseOffsetRad: num(tr, "phaseOffsetRad", phase),
      };
    }
    if (kind === "swirl") {
      return {
        kind: "swirl",
        centerXPx: num(tr, "centerXPx", VIEWPORT_W * 0.5),
        centerYPx: num(tr, "centerYPx", VIEWPORT_H * 0.5),
        radiusPx: num(tr, "radiusPx", Math.hypot(VIEWPORT_W, VIEWPORT_H) * 0.55),
        twistRad: num(tr, "twistRad", 1.2),
        rippleAmp: num(tr, "rippleAmp", 0.1),
        rippleFreq: num(tr, "rippleFreq", 3),
        timeRadPerTick: num(tr, "timeRadPerTick", 0.03),
        phaseOffsetRad: num(tr, "phaseOffsetRad", phase),
      };
    }
    if (kind === "polarscroll" || kind === "polar") {
      return {
        kind: "polarScroll",
        centerXPx: num(tr, "centerXPx", VIEWPORT_W * 0.5),
        centerYPx: num(tr, "centerYPx", VIEWPORT_H * 0.5),
        radiusPx: num(tr, "radiusPx", Math.hypot(VIEWPORT_W, VIEWPORT_H) * 0.55),
        angleRadPerTick: num(tr, "angleRadPerTick", 0.02),
        radialPxPerTick: num(tr, "radialPxPerTick", 0),
        strength: num(tr, "strength", 1),
        phaseOffsetRad: num(tr, "phaseOffsetRad", phase),
      };
    }
    return null;
  }

  function applyDistortions(uv, distortions, oxDevice, oyDevice, simTick) {
    for (const d of distortions) {
      if (d.kind === "scanline") {
        const phase = simTick * d.timeRadPerTick + d.phaseOffsetRad;
        const ref = Math.sin(phase);
        const amp = d.ampPx * d.strength;
        const patternRow = Math.round(uv[1]) - oyDevice;
        const dr = patternRow - d.pinnedRow;
        uv[0] -= amp * (Math.sin(phase + dr * d.phasePerRowRad) - ref);
      } else if (d.kind === "wave2d") {
        const phase = simTick * d.timeRadPerTick + d.phaseOffsetRad;
        const ref = Math.sin(phase);
        const dc = Math.round(uv[0]) - oxDevice - d.pinnedCol;
        const dr = Math.round(uv[1]) - oyDevice - d.pinnedRow;
        uv[0] -= d.ampXPx * (Math.sin(phase + dc * d.phasePerColRad) - ref);
        uv[1] -= d.ampYPx * (Math.sin(phase + dr * d.phasePerRowRad) - ref);
      } else if (d.kind === "ripple") {
        const dx = uv[0] - d.centerXPx;
        const dy = uv[1] - d.centerYPx;
        const r = Math.hypot(dx, dy);
        if (r < 1e-4) continue;
        const radius = Math.max(8, d.radiusPx);
        const norm = r / radius;
        const theta = Math.atan2(dy, dx);
        const phase = simTick * d.timeRadPerTick + d.phaseOffsetRad;
        const wave = d.ampPx * Math.sin(phase + norm * d.rings * Math.PI * 2);
        const sampleR = r - wave;
        uv[0] = d.centerXPx + sampleR * Math.cos(theta);
        uv[1] = d.centerYPx + sampleR * Math.sin(theta);
      } else if (d.kind === "fisheye") {
        const dx = uv[0] - d.centerXPx;
        const dy = uv[1] - d.centerYPx;
        const dist = Math.hypot(dx, dy);
        const radius = Math.max(8, d.radiusPx);
        const norm = dist / radius;
        if (norm > 1.25) continue;
        const phase = simTick * d.timeRadPerTick + d.phaseOffsetRad;
        const ripple = 1 + d.rippleAmp * Math.sin(phase + norm * d.rippleFreq);
        let cw = 1 - Math.min(1, norm);
        cw = cw * cw * (3 - 2 * cw);
        const zoom = 1 + d.strength * cw * ripple;
        if (Math.abs(zoom) < 1e-6) continue;
        uv[0] = d.centerXPx + dx / zoom;
        uv[1] = d.centerYPx + dy / zoom;
      } else if (d.kind === "swirl") {
        const dx = uv[0] - d.centerXPx;
        const dy = uv[1] - d.centerYPx;
        const r = Math.hypot(dx, dy);
        if (r < 1e-4) continue;
        const radius = Math.max(8, d.radiusPx);
        const norm = Math.min(1.25, r / radius);
        const theta = Math.atan2(dy, dx);
        const phase = simTick * d.timeRadPerTick + d.phaseOffsetRad;
        const ripple = 1 + d.rippleAmp * Math.sin(phase + norm * d.rippleFreq);
        const twist = d.twistRad * norm * ripple + phase * 0.35;
        const sampleTheta = theta - twist;
        uv[0] = d.centerXPx + r * Math.cos(sampleTheta);
        uv[1] = d.centerYPx + r * Math.sin(sampleTheta);
      } else if (d.kind === "polarScroll") {
        const dx = uv[0] - d.centerXPx;
        const dy = uv[1] - d.centerYPx;
        const r = Math.hypot(dx, dy);
        const theta = Math.atan2(dy, dx);
        const str = d.strength;
        const phase = simTick * d.angleRadPerTick * str + d.phaseOffsetRad;
        const radial = simTick * d.radialPxPerTick * str;
        uv[0] = d.centerXPx + (r - radial) * Math.cos(theta - phase);
        uv[1] = d.centerYPx + (r - radial) * Math.sin(theta - phase);
      }
    }
  }

  function resolveLayer(layerIndex, layer, sprites, cameraXSubpx, cameraYSubpx, simTick) {
    const spriteId = str(layer, "sprite", "");
    const sprite = sprites.get(spriteId);
    if (!sprite) return null;
    const frameW = num(layer, "frameW", detectFrameWidth(sprite));
    const frameH = num(layer, "frameH", detectFrameHeight(sprite));
    const frameCount = num(layer, "frameCount", detectFrameCount(sprite));
    if (frameW <= 0 || frameH <= 0) return null;
    let ox = 0;
    let oy = 0;
    const spatial = [];
    const transforms = Array.isArray(layer.transforms) ? layer.transforms : [];
    for (const tr of transforms) {
      const kind = str(tr, "kind", "");
      if (kind === "scroll") {
        ox += (num(tr, "vxSubpxPerTick", 0) * simTick) >> 8;
        oy += (num(tr, "vySubpxPerTick", 0) * simTick) >> 8;
      } else if (kind === "cameraParallax") {
        ox += (cameraXSubpx * num(tr, "mulX", 256)) >> 16;
        oy += (cameraYSubpx * num(tr, "mulY", 256)) >> 16;
      } else {
        const d = parseDistortion(tr, layerIndex);
        if (d) spatial.push(d);
      }
    }
    const animateFramesRaw = layer.animateFrames;
    const animateFrames =
      Array.isArray(animateFramesRaw) && animateFramesRaw.length
        ? animateFramesRaw.map((f) => Math.max(0, Math.min(frameCount - 1, Number(f) || 0)))
        : [Math.max(0, Math.min(frameCount - 1, num(layer, "frameIndex", 0)))];
    return {
      sprite,
      spritePx: readSpritePixels(sprite),
      frameW,
      frameH,
      frameCount,
      frameMode: str(layer, "frameMode", "single"),
      frameIndex: num(layer, "frameIndex", 0),
      animateFrames,
      animateTicksPerFrame: Math.max(1, num(layer, "ticksPerFrame", 8)),
      animateLoop: bool(layer, "animateLoop", true),
      opacity: num(layer, "opacity", 255),
      blend: str(layer, "blend", "normal"),
      zIndex: num(layer, "zIndex", 0),
      originX: ox,
      originY: oy,
      spatial,
    };
  }

  function drawLayerFlat(dest, w, h, pixelScale, layer, simTick, skipMask) {
    const fw = layer.frameW;
    const fh = layer.frameH;
    const ox = pixelScale > 1 ? Math.floor(layer.originX / pixelScale) : layer.originX;
    const oy = pixelScale > 1 ? Math.floor(layer.originY / pixelScale) : layer.originY;
    const scratch = new Uint32Array(w * h);
    const sw = layer.sprite.width;
    const sh = layer.sprite.height;
    const startTx = floorDiv(ox, fw) - 1;
    const endTx = floorDiv(ox + w, fw) + 1;
    const startTy = floorDiv(oy, fh) - 1;
    const endTy = floorDiv(oy + h, fh) + 1;
    for (let ty = startTy; ty <= endTy; ty++) {
      for (let tx = startTx; tx <= endTx; tx++) {
        const frame = pickFrame(layer, tx, ty, simTick);
        const sx = frame * fw;
        if (sx + fw > sw || fh > sh) continue;
        const dx = tx * fw - ox;
        const dy = ty * fh - oy;
        for (let ly = 0; ly < fh; ly++) {
          const row = dy + ly;
          if (row < 0 || row >= h) continue;
          const destRow = row * w;
          const srcRow = (ly * sw) | 0;
          for (let lx = 0; lx < fw; lx++) {
            const col = dx + lx;
            if (col < 0 || col >= w) continue;
            scratch[destRow + col] = layer.spritePx[sx + lx + srcRow];
          }
        }
      }
    }
    compositeOnto(dest, scratch, w, h, layer.blend, layer.opacity / 255, skipMask);
  }

  function drawLayerDistorted(dest, w, h, pixelScale, layer, simTick, skipMask) {
    const fw = layer.frameW;
    const fh = layer.frameH;
    const oxDevice = layer.originX;
    const oyDevice = layer.originY;
    const ox = pixelScale > 1 ? Math.floor(oxDevice / pixelScale) : oxDevice;
    const oy = pixelScale > 1 ? Math.floor(oyDevice / pixelScale) : oyDevice;
    const spriteW = layer.sprite.width;
    const spriteH = layer.sprite.height;
    const scratch = new Uint32Array(w * h);
    const uv = [0, 0];
    const sampleScale = Math.max(1, pixelScale);
    for (let sy = 0; sy < h; sy++) {
      const rowBase = sy * w;
      for (let sx = 0; sx < w; sx++) {
        const idx = rowBase + sx;
        if (skipMask && skipMask[idx]) continue;
        uv[0] = (sx + 0.5) * sampleScale;
        uv[1] = (sy + 0.5) * sampleScale;
        applyDistortions(uv, layer.spatial, oxDevice, oyDevice, simTick);
        const px =
          pixelScale > 1 ? Math.round(uv[0] / sampleScale) - ox : Math.round(uv[0]) - ox;
        const py =
          pixelScale > 1 ? Math.round(uv[1] / sampleScale) - oy : Math.round(uv[1]) - oy;
        const tileX = floorDiv(px, fw);
        const tileY = floorDiv(py, fh);
        const localX = floorMod(px, fw);
        const localY = floorMod(py, fh);
        if (localY < 0 || localY >= fh || localX < 0 || localX >= fw) continue;
        const frame = pickFrame(layer, tileX, tileY, simTick);
        const srcX = frame * fw + localX;
        if (srcX < 0 || srcX >= spriteW || localY >= spriteH) continue;
        scratch[idx] = layer.spritePx[srcX + localY * spriteW];
      }
    }
    compositeOnto(dest, scratch, w, h, layer.blend, layer.opacity / 255, skipMask);
  }

  function pixelsToImageData(pixels, w, h) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < pixels.length; i++, j += 4) {
      const p = pixels[i];
      data[j] = (p >> 16) & 255;
      data[j + 1] = (p >> 8) & 255;
      data[j + 2] = p & 255;
      data[j + 3] = (p >>> 24) & 255;
    }
    return new ImageData(data, w, h);
  }

  class BackgroundRenderer {
    static render(preset, sprites, targetCtx, w, h, cameraXSubpx, cameraYSubpx, simTick, options) {
      if (!preset || !targetCtx) return;
      const layersRaw = Array.isArray(preset.layers) ? preset.layers : [];
      const layers = [];
      for (let i = 0; i < layersRaw.length; i++) {
        const resolved = resolveLayer(i, layersRaw[i], sprites, cameraXSubpx, cameraYSubpx, simTick);
        if (resolved) layers.push(resolved);
      }
      layers.sort((a, b) => a.zIndex - b.zIndex);
      const pixelScale = Math.max(1, options?.pixelScale ?? 1);
      const skipMask = options?.occlusionMask ?? null;
      const accum = new Uint32Array(w * h);
      for (const layer of layers) {
        if (layer.spatial.length) drawLayerDistorted(accum, w, h, pixelScale, layer, simTick, skipMask);
        else drawLayerFlat(accum, w, h, pixelScale, layer, simTick, skipMask);
      }
      targetCtx.putImageData(pixelsToImageData(accum, w, h), 0, 0);
    }
  }

  class BackgroundPresetRegistry {
    presets = new Map();
    sprites = new Map();
    bossPresetIds = [];
    secretPresetIds = [];

    static async load(assetBase, loadImage) {
      const reg = new BackgroundPresetRegistry();
      const base = assetBase.endsWith("/") ? assetBase : assetBase + "/";
      const spriteNames = new Set([...BOSS_IDS, ...SECRET_IDS]);
      await Promise.all(
        [...spriteNames].map(async (id) => {
          try {
            const img = await loadImage(`sprites/background/${id}.png`);
            if (img) reg.sprites.set(id, img);
          } catch (_e) {
            /* optional */
          }
        })
      );
      const presetIds = [...BOSS_IDS, ...SECRET_IDS];
      await Promise.all(
        presetIds.map(async (id) => {
          try {
            const res = await fetch(new URL(`sprites/background/${id}.preset.json`, base).href);
            if (!res.ok) return;
            const preset = await res.json();
            preset.id = preset.id || id;
            reg.presets.set(id, preset);
            if (id.startsWith("boss")) reg.bossPresetIds.push(id);
            else if (id.startsWith("secret")) reg.secretPresetIds.push(id);
          } catch (_e) {
            /* optional */
          }
        })
      );
      reg.bossPresetIds.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      reg.secretPresetIds.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return reg;
    }

    preset(id) {
      return this.presets.get(id) ?? null;
    }

    spritesMap() {
      return this.sprites;
    }

    pickBossPresetId(contentSeed) {
      return this.pickFromFamily(this.bossPresetIds, contentSeed, BOSS_PRESET_PICK_SALT);
    }

    pickSecretPresetId(contentSeed) {
      return this.pickFromFamily(this.secretPresetIds, contentSeed, SECRET_PRESET_PICK_SALT);
    }

    pickFromFamily(ids, seed, salt) {
      if (!ids.length) return null;
      const pick = BigInt(seed >>> 0) ^ salt;
      const idx = Number(pick % BigInt(ids.length));
      return ids[idx];
    }
  }

  function roomKindUsesMathBackground(kind) {
    const k = String(kind || "").toUpperCase();
    return k === "BOSS" || k === "SECRET" || k === "SUPER_SECRET";
  }

  function buildBackgroundOcclusionMask(map, cameraX, cameraY, maskW, maskH, tileSize, viewW, viewH, zoom) {
    const mask = new Array(maskW * maskH).fill(true);
    if (!map) return mask;
    const scaleX = Math.max(1, Math.floor(viewW / maskW));
    const scaleY = Math.max(1, Math.floor(viewH / maskH));
    const camTx = viewW * 0.5 - cameraX * zoom;
    const camTy = viewH * 0.5 - cameraY * zoom;
    const TILE_EMPTY = 0;
    for (let my = 0; my < maskH; my++) {
      const row = my * maskW;
      const worldY = ((my + 0.5) * scaleY - camTy) / zoom;
      const ty = Math.floor(worldY / tileSize);
      for (let mx = 0; mx < maskW; mx++) {
        const worldX = ((mx + 0.5) * scaleX - camTx) / zoom;
        const tx = Math.floor(worldX / tileSize);
        if (map.tileAt(tx, ty) === TILE_EMPTY) mask[row + mx] = false;
      }
    }
    return mask;
  }

  global.VernanBackground = {
    BackgroundPresetRegistry,
    BackgroundRenderer,
    roomKindUsesMathBackground,
    buildBackgroundOcclusionMask,
    VIEWPORT_W,
    VIEWPORT_H,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
