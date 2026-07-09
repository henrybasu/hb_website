/**
 * Breakable-tile debris (Java BrickChunk visual parity).
 */
(() => {
  const GRAVITY = 1800;
  const SIZE = 8;
  const SPAWN_OMEGA_RAD_PER_SEC = 7.0;

  function extractSubSprite(source, qx, qy) {
    if (!source) return null;
    const c = document.createElement("canvas");
    c.width = SIZE;
    c.height = SIZE;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    try {
      ctx.drawImage(source, qx, qy, SIZE, SIZE, 0, 0, SIZE, SIZE);
      return c;
    } catch (_e) {
      return null;
    }
  }

  class BrickChunk {
    constructor(x, y, vx, vy, opts = {}) {
      this.x = x;
      this.y = y;
      this.vx = vx;
      this.vy = vy;
      const o = typeof opts === "number" ? { hue: opts } : opts;
      this.hue = o.hue ?? 22;
      this.sprite = o.sprite ?? null;
      this.angle = o.angle ?? (Math.random() - 0.5) * 0.4;
      this.omega = o.omega ?? (Math.random() - 0.5) * 14;
      this.onGround = false;
      this.dead = false;
    }

    update(dt, map, tileSize, isSolidAt) {
      this.vy = Math.min(this.vy + GRAVITY * dt * 0.85, 420);
      if (!this.onGround) {
        this.vx *= Math.exp(-2.8 * dt);
      }
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.angle += this.omega * dt;

      const cx = this.x + SIZE * 0.5;
      const footY = this.y + SIZE;
      const tx = Math.floor(cx / tileSize);
      const ty = Math.floor((footY + 1) / tileSize);
      if (isSolidAt(map, tx, ty) && this.vy >= 0) {
        this.y = ty * tileSize - SIZE;
        this.vy *= -0.28;
        this.vx *= 0.55;
        this.omega *= 0.6;
        this.onGround = true;
        this.vx *= Math.pow(0.22, (dt * 60) / 14);
        if (Math.abs(this.vx) < 3) this.vx = 0;
      } else {
        this.onGround = false;
      }

      if (this.y > map.getHeight() * tileSize + 64) this.dead = true;
    }
  }

  function spawnBreakableChunks(bx, by, rnd, tileSnap = null, velocityScale = 1) {
    const next = () => rnd.nextDouble();
    const scale = velocityScale > 0 ? velocityScale : 1;
    const out = [];
    for (let i = 0; i < 4; i++) {
      const qx = (i % 2) * SIZE;
      const qy = Math.floor(i / 2) * SIZE;
      const hue = 22 + next() * 18;
      const sprite = extractSubSprite(tileSnap, qx, qy);
      const omega0 = (next() - 0.5) * 2 * SPAWN_OMEGA_RAD_PER_SEC * scale;
      const angle0 = (next() - 0.5) * 0.4 * scale;
      out.push(
        new BrickChunk(
          bx + qx,
          by + qy,
          (next() - 0.5) * 140 * scale,
          (-next() * 95 - 18) * scale,
          { hue, sprite, angle: angle0, omega: omega0 }
        )
      );
    }
    return out;
  }

  function drawChunks(ctx, chunks) {
    for (const c of chunks) {
      if (c.dead) continue;
      ctx.save();
      ctx.translate(c.x + SIZE * 0.5, c.y + SIZE * 0.5);
      ctx.rotate(c.angle);
      if (c.sprite) {
        try {
          ctx.drawImage(c.sprite, -SIZE * 0.5, -SIZE * 0.5, SIZE, SIZE);
        } catch (_e) {
          ctx.fillStyle = `hsl(${c.hue}, 28%, ${38 + (c.hue % 7)}%)`;
          ctx.fillRect(-SIZE * 0.5, -SIZE * 0.5, SIZE, SIZE);
        }
      } else {
        ctx.fillStyle = `hsl(${c.hue}, 28%, ${38 + (c.hue % 7)}%)`;
        ctx.fillRect(-SIZE * 0.5, -SIZE * 0.5, SIZE, SIZE);
      }
      ctx.restore();
    }
  }

  window.VernanBrickChunks = {
    BrickChunk,
    spawnBreakableChunks,
    drawChunks,
    tick(chunks, dt, map, tileSize, isSolidAt) {
      for (const c of chunks) {
        if (!c.dead) c.update(dt, map, tileSize, isSolidAt);
      }
      for (let i = chunks.length - 1; i >= 0; i--) {
        if (chunks[i].dead) chunks.splice(i, 1);
      }
    },
  };
})();
