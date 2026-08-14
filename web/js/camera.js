// A free-flying camera. It owns where you are and where you are facing;
// it does not own the sphere's orientation, which is `SphereModel`.
//
//   move the mouse   look around (yaw/pitch in place)
//   click and drag   turn the sphere — forwarded to onDragRotate, the
//                    camera itself does not move
//   wheel            dolly along the view axis
//   WASD/space/ctrl  fly
//
// Orientation is yaw/pitch rather than a free quaternion: keeping the
// horizon level is what makes flying navigable, and the free tumbling
// belongs to the sphere now.

import * as m4 from './mat4.js';

const DEG = Math.PI / 180;
const WORLD_UP = [0, 0, 1];
const PITCH_LIMIT = 89.5 * DEG;

// Scene units per second, scaled by how far out you are so flying feels
// the same near the shell as far from it. The floor keeps movement alive
// if you fly exactly through the centre.
const FLY_SPEED = 1.1;
const SPRINT = 4.0;
const SCALE_FLOOR = 0.4;
const MAX_RANGE = 200;

const LOOK_SPEED = 0.0022;   // radians per pixel
const DRAG_SPEED = 0.0060;   // radians per pixel, sphere rotation

const KEYS = {
  KeyW: 'fwd', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  Space: 'up', ControlLeft: 'down', ControlRight: 'down',
  // Ctrl+W is reserved by the browser and closes the tab, so descending
  // while moving forward needs a binding the browser will not intercept.
  KeyC: 'down',
};
const SPRINT_KEYS = new Set(['ShiftLeft', 'ShiftRight']);
const MOUSELOOK_KEY = 'KeyE';

export class FlyCamera {
  constructor(canvas, { distance = 11, fovy = 45 * DEG } = {}) {
    const yaw0 = 35 * DEG;
    const pitch0 = 22 * DEG;
    const cp = Math.cos(pitch0);
    // Start where the old orbit camera started, facing the origin.
    this.pos = [
      distance * cp * Math.cos(yaw0),
      distance * cp * Math.sin(yaw0),
      distance * Math.sin(pitch0),
    ];
    this.yaw = yaw0 + Math.PI;
    this.pitch = -pitch0;
    this.home = { pos: this.pos.slice(), yaw: this.yaw, pitch: this.pitch };

    this.fovy = fovy;
    // Off by default: with it on, every trip across the canvas to reach
    // the controls turns the view. Tap E when you want to look around.
    this.mouseLook = false;
    this.dirty = true;
    this.held = new Set();
    this.sprint = false;
    /** Set by the app: receives pixel deltas while the pointer is down. */
    this.onDragRotate = null;
    /** Set by the app: called when E toggles mouse look. */
    this.onMouseLookChange = null;

    this._attach(canvas);
    this._attachKeys();
  }

  _attach(canvas) {
    let dragging = false;
    let last = null;

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      last = [e.clientX, e.clientY];
      canvas.setPointerCapture(e.pointerId);
    });

    const stop = (e) => {
      dragging = false;
      if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);

    // Re-anchor on entry: crossing back from the panel would otherwise
    // arrive as one huge delta and snap the view round.
    const anchor = (e) => { last = [e.clientX, e.clientY]; };
    canvas.addEventListener('pointerenter', anchor);
    canvas.addEventListener('pointerover', anchor);
    canvas.addEventListener('pointerleave', () => { if (!dragging) last = null; });

    canvas.addEventListener('pointermove', (e) => {
      if (!last) { last = [e.clientX, e.clientY]; return; }
      const dx = e.clientX - last[0];
      const dy = e.clientY - last[1];
      last = [e.clientX, e.clientY];
      if (!dx && !dy) return;

      if (dragging) {
        // Turning the sphere: slower when it is small on screen, so a
        // drag covers a comparable amount of it at any distance.
        const k = DRAG_SPEED * Math.min(1, this.range / 11 + 0.35);
        this.onDragRotate?.(dx * k, dy * k);
      } else if (this.mouseLook) {
        this.look(-dx * LOOK_SPEED, -dy * LOOK_SPEED);
      }
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      // Trackpads report small per-event deltas, mouse wheels large ones;
      // clamping keeps a single notch from jumping several octaves.
      const step = Math.max(-1, Math.min(1, e.deltaY / 100));
      this.dolly(this.range * (1 - Math.exp(step * 0.22)));
    }, { passive: false });
  }

  _attachKeys() {
    // A focused control owns space — it would toggle the checkbox instead
    // of lifting the camera. The letter keys do nothing to a slider or a
    // button, so those stay live and the panel needs no click to escape.
    const controlFocused = () => {
      const el = document.activeElement;
      return el && el !== document.body && /^(INPUT|BUTTON|SELECT|TEXTAREA)$/.test(el.tagName);
    };

    window.addEventListener('keydown', (e) => {
      if (SPRINT_KEYS.has(e.code)) this.sprint = true;
      // Tap, not hold — the repeat guard stops a held key from strobing.
      if (e.code === MOUSELOOK_KEY && !e.repeat
          && !e.metaKey && !e.altKey && !e.ctrlKey) {
        this.setMouseLook(!this.mouseLook);
        return;
      }
      const dir = KEYS[e.code];
      if (!dir || e.repeat || e.metaKey || e.altKey) return;
      if (e.code === 'Space' && controlFocused()) return;
      this.held.add(dir);
      // Space scrolls the page; ctrl+S/A/D are save, select-all and
      // bookmark. All are preventable — ctrl+W is not, hence KeyC above.
      e.preventDefault();
    });

    window.addEventListener('keyup', (e) => {
      if (SPRINT_KEYS.has(e.code)) this.sprint = false;
      if (KEYS[e.code]) this.held.delete(KEYS[e.code]);
    });

    // Held keys would otherwise stick down across a tab switch.
    window.addEventListener('blur', () => {
      this.held.clear();
      this.sprint = false;
    });
  }

  setMouseLook(on) {
    if (on === this.mouseLook) return;
    this.mouseLook = on;
    this.onMouseLookChange?.(on);
  }

  /** Turn in place. Pitch is clamped so the view never rolls over. */
  look(dYaw, dPitch) {
    this.yaw += dYaw;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + dPitch));
    this.dirty = true;
  }

  /** Move along the view axis by `d` scene units. */
  dolly(d) {
    const { fwd } = this.basis();
    const next = [
      this.pos[0] + fwd[0] * d,
      this.pos[1] + fwd[1] * d,
      this.pos[2] + fwd[2] * d,
    ];
    if (Math.hypot(...next) > MAX_RANGE) return;
    this.pos = next;
    this.dirty = true;
  }

  reset() {
    this.pos = this.home.pos.slice();
    this.yaw = this.home.yaw;
    this.pitch = this.home.pitch;
    this.held.clear();
    this.sprint = false;
    this.dirty = true;
  }

  /** Distance from the sphere's centre — the scene's only fixed landmark. */
  get range() {
    return Math.hypot(this.pos[0], this.pos[1], this.pos[2]);
  }

  get eye() {
    return this.pos;
  }

  /** Camera axes in world space: +right is screen right, +back is toward the eye. */
  basis() {
    const cp = Math.cos(this.pitch);
    const fwd = [cp * Math.cos(this.yaw), cp * Math.sin(this.yaw), Math.sin(this.pitch)];
    const right = m4.normalize(m4.cross(fwd, WORLD_UP));
    return { fwd, right, up: m4.cross(right, fwd), back: m4.scale(fwd, -1) };
  }

  /** Advance held-key movement. Returns true if anything moved. */
  tick(dt) {
    if (!this.held.size) return false;
    const { right, fwd, up } = this.basis();
    const scale = Math.max(this.range, SCALE_FLOOR);
    const step = scale * FLY_SPEED * (this.sprint ? SPRINT : 1) * Math.min(dt, 0.1);
    const move = [0, 0, 0];
    const add = (v, s) => {
      move[0] += v[0] * s;
      move[1] += v[1] * s;
      move[2] += v[2] * s;
    };
    if (this.held.has('fwd')) add(fwd, step);
    if (this.held.has('back')) add(fwd, -step);
    if (this.held.has('right')) add(right, step);
    if (this.held.has('left')) add(right, -step);
    if (this.held.has('up')) add(up, step);
    if (this.held.has('down')) add(up, -step);

    this.pos = [this.pos[0] + move[0], this.pos[1] + move[1], this.pos[2] + move[2]];
    this.dirty = true;
    return true;
  }

  /** View-projection for the given drawing-buffer size. */
  update(width, height) {
    const { right, up, back } = this.basis();
    const view = m4.viewFromBasis(right, up, back, this.pos);
    // Clip planes track how far the camera is from the scene.
    const d = Math.max(this.range, SCALE_FLOOR);
    this.near = Math.max(0.002, d * 0.01);
    this.far = d + 40;
    const proj = m4.perspective(this.fovy, width / height, this.near, this.far);
    this.viewProj = m4.multiply(proj, view);
    this.dirty = false;
    return this.viewProj;
  }

  /** Scene units per screen pixel at world point `p`. */
  worldPerPixel(p, heightPx) {
    const d = Math.hypot(p[0] - this.pos[0], p[1] - this.pos[1], p[2] - this.pos[2]);
    return (2 * Math.tan(this.fovy / 2) * d) / heightPx;
  }
}
