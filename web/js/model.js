// The sphere's own orientation — what dragging turns.
//
// Kept separate from the camera on purpose. Turning the sphere by moving
// the camera around it only looks the same while the camera is pointed at
// the centre; once you have flown off with WASD, orbiting swings the
// sphere across the view instead of spinning it in place. A model
// rotation about the sphere's centre is the real thing, and leaves the
// camera exactly where it is.

import * as m4 from './mat4.js';

export class SphereModel {
  constructor() {
    this.q = [0, 0, 0, 1];
    this.dirty = true;
  }

  reset() {
    this.q = [0, 0, 0, 1];
    this.dirty = true;
  }

  set(q) {
    this.q = m4.quatNormalize(q.slice());
    this.dirty = true;
  }

  /**
   * Turn by screen-space pixel deltas about the sphere's centre, so the
   * point under the cursor follows the cursor. The axes are the camera's
   * own up and right in world space, which is what makes the rotation
   * read as screen-relative however the camera happens to be posed.
   */
  rotateScreen(dx, dy, basis) {
    if (!dx && !dy) return;
    const dq = m4.quatMul(
      m4.quatAxisAngle(basis.up, dx),
      m4.quatAxisAngle(basis.right, dy),
    );
    // Pre-multiplied: the new turn is expressed in world axes, so it
    // applies after whatever rotation the sphere already carries.
    this.q = m4.quatNormalize(m4.quatMul(dq, this.q));
    this.dirty = true;
  }

  get matrix() {
    return m4.quatToMat4(this.q);
  }

  /** World direction -> the sphere's own (RA/Dec) frame, and back. */
  toLocal(v) {
    return m4.quatRotate(m4.quatConj(this.q), v);
  }

  toWorld(v) {
    return m4.quatRotate(this.q, v);
  }
}
