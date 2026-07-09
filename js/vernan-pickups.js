/**
 * World pickups + breakable loot rolls (Java WorldPickup / BreakableLootRoll port).
 */
(function (global) {
  "use strict";

  const TILE_SIZE = 16;
  const GRAVITY = 300;
  const PICKUP_SIZE = 8;
  const LOOT_SALT = 0x1007ab1e10adn;

  const PickupKind = {
    HEART: "HEART",
    KEY: "KEY",
    COIN_1: "COIN_1",
    COIN_5: "COIN_5",
    COIN_10: "COIN_10",
  };

  const SpawnStyle = {
    BREAKABLE: "BREAKABLE",
    ROOM_CLEAR: "ROOM_CLEAR",
  };

  function terrainBrickRngSeed(runSeed, roomId, tx, ty) {
    return Number(
      BigInt(runSeed >>> 0) ^
        BigInt(tx) * 0x9e3779b1n ^
        BigInt(ty) * 0x85ebca77n ^
        BigInt(roomId) * 37n
    );
  }

  function terrainLootRngSeed(runSeed, roomId, tx, ty) {
    return Number(
      BigInt(runSeed >>> 0) ^
        BigInt(tx) * 0x9e3779b1n ^
        BigInt(ty) * 0x85ebca77n ^
        BigInt(roomId) * 37n ^
        LOOT_SALT
    );
  }

  function roomClearRngSeed(runSeed, roomId, dungeonLevel, enemiesKilledThisRun) {
    return Number(
      BigInt(runSeed >>> 0) ^
        BigInt(roomId) * 0xc2b2ae3dn ^
        BigInt(dungeonLevel) * 0x9e3779b97f4a7c15n ^
        BigInt(enemiesKilledThisRun) * 0xd1b54a32d192ed03n ^
        0xdec0de10n
    );
  }

  function rollCoinKind(rnd) {
    const d = rnd.nextDouble();
    if (d < 0.9) return PickupKind.COIN_1;
    if (d < 0.98) return PickupKind.COIN_5;
    return PickupKind.COIN_10;
  }

  function rollKind(rnd) {
    const r = rnd.nextDouble();
    if (r < 0.08) return PickupKind.HEART;
    if (r < 0.16) return PickupKind.KEY;
    if (r < 0.76) return rollCoinKind(rnd);
    return null;
  }

  const BreakableLootRoll = {
    terrainLootKind(runSeed, roomId, tx, ty, javaRandom) {
      return rollKind(javaRandom(terrainLootRngSeed(runSeed, roomId, tx, ty)));
    },
    terrainBrickRng(runSeed, roomId, tx, ty, javaRandom) {
      return javaRandom(terrainBrickRngSeed(runSeed, roomId, tx, ty));
    },
  };

  function rollRoomClearPickupKind(rnd) {
    const t = rnd.nextInt(3);
    if (t === 0) return PickupKind.HEART;
    if (t === 1) return PickupKind.KEY;
    return rollRoomClearCoinKind(rnd);
  }

  function rollRoomClearCoinKind(rnd) {
    const d = rnd.nextDouble();
    if (d < 0.05) return PickupKind.COIN_10;
    if (d < 0.15) return PickupKind.COIN_5;
    return PickupKind.COIN_1;
  }

  function overlapsSolids(map, box) {
    const x0 = Math.floor(box.x / TILE_SIZE);
    const x1 = Math.floor((box.x + box.w - 1e-5) / TILE_SIZE);
    const y0 = Math.floor(box.y / TILE_SIZE);
    const y1 = Math.floor((box.y + box.h - 1e-5) / TILE_SIZE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (map.isSolidTile(tx, ty)) return true;
      }
    }
    return false;
  }

  function movePickup(map, x, y, w, h, vx, vy, dt) {
    let nx = x + vx * dt;
    let ny = y + vy * dt;
    let nvx = vx;
    let nvy = vy;
    let onGround = false;

    if (vx !== 0) {
      if (!overlapsSolids(map, { x: nx, y, w, h })) {
        x = nx;
      } else {
        const step = vx > 0 ? 1 : -1;
        while (Math.abs(nx - x) > 0.01) {
          const tryX = x + step;
          if (!overlapsSolids(map, { x: tryX, y, w, h })) x = tryX;
          else break;
        }
        nvx = 0;
      }
    }

    if (vy !== 0) {
      if (!overlapsSolids(map, { x, y: ny, w, h })) {
        y = ny;
      } else {
        const step = vy > 0 ? 1 : -1;
        while (Math.abs(ny - y) > 0.01) {
          const tryY = y + step;
          if (!overlapsSolids(map, { x, y: tryY, w, h })) y = tryY;
          else break;
        }
        if (vy > 0) onGround = true;
        nvy = 0;
      }
    }

    return { x, y, vx: nvx, vy: nvy, onGround };
  }

  class WorldPickup {
    constructor(kind, x, y, vx, vy, omega) {
      this.kind = kind;
      this.x = x;
      this.y = y;
      this.vx = vx;
      this.vy = vy;
      this.omega = omega;
      this.angleRad = 0;
      this.animTime = 0;
      this.w = PICKUP_SIZE;
      this.h = PICKUP_SIZE;
    }

    static finishCreate(kind, x, y, style, rnd) {
      const omega = (rnd.nextDouble() - 0.5) * (style === SpawnStyle.ROOM_CLEAR ? 10 : 6);
      const p = new WorldPickup(kind, x, y, 0, 0, omega);
      if (style === SpawnStyle.ROOM_CLEAR) {
        p.vy = -(100 + rnd.nextDouble() * 55);
        p.vx = (rnd.nextDouble() - 0.5) * 140;
      } else {
        p.vy = -(38 + rnd.nextDouble() * 28);
        p.vx = (rnd.nextDouble() - 0.5) * 100;
      }
      return p;
    }

    static createFromCenter(kind, centerX, centerY, style, rnd) {
      return WorldPickup.finishCreate(
        kind,
        centerX - PICKUP_SIZE * 0.5,
        centerY - PICKUP_SIZE * 0.5,
        style,
        rnd
      );
    }

    static createAtFeet(kind, feetCenterX, feetY, style, rnd) {
      return WorldPickup.finishCreate(
        kind,
        feetCenterX - PICKUP_SIZE * 0.5,
        feetY - PICKUP_SIZE,
        style,
        rnd
      );
    }

    hitbox() {
      return { x: this.x, y: this.y, w: this.w, h: this.h };
    }

    update(dt, map) {
      this.animTime += dt;
      this.angleRad += this.omega * dt;
      this.vy = Math.min(320, this.vy + GRAVITY * dt);
      const r = movePickup(map, this.x, this.y, this.w, this.h, this.vx, this.vy, dt);
      this.x = r.x;
      this.y = r.y;
      this.vx = r.vx;
      this.vy = r.vy;
      if (r.onGround) {
        this.vx *= Math.exp(-54 * dt);
        if (Math.abs(this.vx) < 2.5) this.vx = 0;
        this.omega *= Math.exp(-8 * dt);
        if (Math.abs(this.omega) < 0.05) this.omega = 0;
      }
    }

    snapshot() {
      return {
        kind: this.kind,
        x: this.x,
        y: this.y,
        vx: this.vx,
        vy: this.vy,
        omega: this.omega,
        angleRad: this.angleRad,
        animTime: this.animTime,
      };
    }

    static fromSnapshot(data) {
      const p = new WorldPickup(data.kind, data.x, data.y, data.vx, data.vy, data.omega ?? 0);
      p.angleRad = data.angleRad ?? 0;
      p.animTime = data.animTime ?? 0;
      return p;
    }
  }

  global.VernanPickups = {
    PickupKind,
    SpawnStyle,
    BreakableLootRoll,
    rollRoomClearPickupKind,
    rollRoomClearCoinKind,
    roomClearRngSeed,
    WorldPickup,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
