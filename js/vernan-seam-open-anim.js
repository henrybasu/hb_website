/**
 * Staggered secret-seam open (SEAM-ANIM-1): freeze gameplay while shell tiles reveal the door.
 * Port of game.world.SecretSeamOpenAnim.
 */
(() => {
  const SEAM_KIND_HORIZONTAL = "HORIZONTAL_DOOR";
  const SEAM_KIND_VERTICAL = "VERTICAL_LADDER";
  const SEAM_ROLE_BREAKABLE = "BREAKABLE";

  const STAGGER_FRAMES = 4;
  const VERTICAL_STAGGER_FRAMES = 8;
  const CAMERA_PAN_STEPS = 15;

  function smoothstep(t) {
    return t * t * (3 - 2 * t);
  }

  function findForBreakable(seams, rid, tx, ty, mapHeight) {
    if (!seams) return null;
    let horizontal = null;
    let vertical = null;
    for (const s of seams) {
      if (s.isDone() || !s.isHiddenBreakable(rid, tx, ty)) continue;
      if (s.kind === SEAM_KIND_VERTICAL) vertical = s;
      else if (s.kind === SEAM_KIND_HORIZONTAL) horizontal = s;
    }
    if (vertical && horizontal) {
      if (vertical.isSouthFaceBreakable?.(mapHeight, rid, tx, ty) || vertical.isNorthFaceBreakable?.(mapHeight, rid, tx, ty)) {
        return vertical;
      }
      return horizontal;
    }
    return vertical ?? horizontal;
  }

  class SecretSeamOpenAnim {
    constructor(seam, roomId, unlockSouthLadderShaft, steps, cameraStartX, cameraTargetX, cameraPanSteps, staggerFrames) {
      this.seam = seam;
      this.roomId = roomId;
      this.unlockSouthLadderShaft = unlockSouthLadderShaft;
      this.steps = steps;
      this.nextStepIndex = 0;
      this.framesUntilNext = 0;
      this.cameraPanStepsRemaining = cameraPanSteps;
      this.cameraPanStepsTotal = cameraPanSteps;
      this.cameraStartX = cameraStartX;
      this.cameraTargetX = cameraTargetX;
      this.staggerFrames = staggerFrames;
      this.finished = false;
      this.onStep = null;
      this.onStrike = null;
    }

    isFinished() {
      return this.finished;
    }

    hasCameraPan() {
      return this.cameraPanStepsTotal > 0 && this.nextStepIndex >= this.steps.length && this.cameraPanStepsRemaining > 0;
    }

    cameraXForStep(totalPanStepsDone) {
      if (this.cameraPanStepsTotal <= 0) return this.cameraTargetX;
      const done = this.cameraPanStepsTotal - this.cameraPanStepsRemaining + totalPanStepsDone;
      const t = Math.min(1, done / this.cameraPanStepsTotal);
      return this.cameraStartX + (this.cameraTargetX - this.cameraStartX) * smoothstep(t);
    }

    applyStrikeStepNow(rooms, strikeTx, strikeTy) {
      if (this.seam.kind === SEAM_KIND_HORIZONTAL) {
        this.applyHorizontalStrikeNow(rooms, strikeTx, strikeTy);
        return;
      }
      for (let i = this.nextStepIndex; i < this.steps.length; i++) {
        const s = this.steps[i];
        if (s.tx === strikeTx && s.ty === strikeTy) {
          this.applyStep(rooms, s);
          this.nextStepIndex = i + 1;
          return;
        }
      }
    }

    applyHorizontalStrikeNow(rooms, strikeTx, strikeTy) {
      for (const c of this.seam.cells) {
        if (c.role !== SEAM_ROLE_BREAKABLE || c.cleared || c.roomId !== this.roomId) continue;
        if (c.tx !== strikeTx || c.ty !== strikeTy) continue;
        const step = { tx: strikeTx, ty: strikeTy, restore: c.restore, countsTowardStagger: false, spawnChunks: false };
        if (this.onStrike) this.onStrike(step);
        this.seam.applyAnimatedStep(rooms, this.roomId, strikeTx, strikeTy, c.restore);
        return;
      }
    }

    tick(rooms, advanceTimeline, applyCameraPanStep) {
      if (this.finished) return true;
      if (advanceTimeline) {
        if (this.framesUntilNext > 0) this.framesUntilNext--;
        while (this.framesUntilNext <= 0 && this.nextStepIndex < this.steps.length) {
          const s = this.steps[this.nextStepIndex++];
          this.applyStep(rooms, s);
          if (s.countsTowardStagger) {
            this.framesUntilNext = this.staggerFrames;
            break;
          }
        }
      }
      const stepsDone = this.nextStepIndex >= this.steps.length;
      if (applyCameraPanStep && stepsDone && this.cameraPanStepsRemaining > 0) {
        this.cameraPanStepsRemaining--;
      }
      const panDone = this.cameraPanStepsTotal <= 0 || this.cameraPanStepsRemaining <= 0;
      if (stepsDone && panDone) {
        this.seam.completeAnimatedOpen(rooms, this.roomId, this.unlockSouthLadderShaft);
        this.finished = true;
        return true;
      }
      return false;
    }

    finishInstant(rooms) {
      while (this.nextStepIndex < this.steps.length) {
        this.applyStep(rooms, this.steps[this.nextStepIndex++]);
      }
      this.seam.completeAnimatedOpen(rooms, this.roomId, this.unlockSouthLadderShaft);
      this.finished = true;
      this.cameraPanStepsRemaining = 0;
    }

    applyStep(rooms, s) {
      if (this.onStep) this.onStep(s);
      this.seam.applyAnimatedStep(rooms, this.roomId, s.tx, s.ty, s.restore);
    }
  }

  function queueHorizontal(seam, roomId, strikeTx, strikeTy) {
    const pending = [];
    for (const c of seam.cells) {
      if (c.role !== SEAM_ROLE_BREAKABLE || c.cleared || c.roomId !== roomId) continue;
      if (c.tx === strikeTx && c.ty === strikeTy) continue;
      pending.push({ tx: c.tx, ty: c.ty, restore: c.restore, countsTowardStagger: true, spawnChunks: true });
    }
    pending.sort((a, b) => a.ty - b.ty);
    return pending;
  }

  function begin(seam, roomId, strikeTx, strikeTy, cameraStartX, cameraTargetX) {
    if (seam.kind === SEAM_KIND_HORIZONTAL) {
      const steps = queueHorizontal(seam, roomId, strikeTx, strikeTy);
      return new SecretSeamOpenAnim(
        seam,
        roomId,
        false,
        steps,
        cameraStartX,
        cameraTargetX,
        CAMERA_PAN_STEPS,
        STAGGER_FRAMES
      );
    }
    if (seam.kind === SEAM_KIND_VERTICAL) {
      const south = seam.isSouthFaceBreakable?.(9999, roomId, strikeTx, strikeTy) ?? false;
      const steps = queueVerticalStrike(seam, roomId, strikeTx, strikeTy);
      return new SecretSeamOpenAnim(
        seam,
        roomId,
        south,
        steps,
        cameraStartX,
        cameraTargetX,
        0,
        VERTICAL_STAGGER_FRAMES
      );
    }
    return null;
  }

  /** Minimal vertical strip: remaining breakables on the seam column above/below strike. */
  function queueVerticalStrike(seam, roomId, strikeTx, strikeTy) {
    const pending = [];
    for (const c of seam.cells) {
      if (c.role !== SEAM_ROLE_BREAKABLE || c.cleared || c.roomId !== roomId) continue;
      if (c.tx === strikeTx && c.ty === strikeTy) continue;
      pending.push({ tx: c.tx, ty: c.ty, restore: c.restore, countsTowardStagger: true, spawnChunks: true });
    }
    if (seam.roomA === roomId) pending.sort((a, b) => b.ty - a.ty);
    else pending.sort((a, b) => a.ty - b.ty);
    return pending;
  }

  window.VernanSeamOpen = {
    STAGGER_FRAMES,
    CAMERA_PAN_STEPS,
    findForBreakable,
    begin,
    SecretSeamOpenAnim,
  };
})();
