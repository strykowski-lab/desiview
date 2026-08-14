// The instrument around the data: the hollow inner shell at z = zmin with
// its graticule, the shell's silhouette, and one radial ruler ticked in
// redshift. All of it grey, thin, and drawn without depth testing so it
// stays legible through the densest part of the cloud — with far-side
// lines dimmed so the frame still reads as three-dimensional.
//
// Lines are drawn as screen-space expanded quads rather than GL_LINES:
// WebGL clamps lineWidth to 1 on essentially every desktop driver, so a
// quad per segment is the only way to set a real thickness.

import { program, buffer } from './glutil.js';
import * as m4 from './mat4.js';

const LINE_VS = `#version 300 es
precision highp float;
in vec2 aCorner;      // (t along segment, side)
in vec3 aA;
in vec3 aB;
in float aWeight;
uniform mat4 uViewProj;
uniform vec3 uEye;
uniform vec2 uViewport;   // drawing-buffer pixels
uniform float uScale;
uniform float uWidthPx;
uniform float uFacingDim; // 1 = dim the far side, 0 = uniform brightness
out float vAlpha;
void main() {
  vec3 wa = aA * uScale;
  vec3 wb = aB * uScale;
  vec4 ca = uViewProj * vec4(wa, 1.0);
  vec4 cb = uViewProj * vec4(wb, 1.0);
  // A segment crossing the near plane cannot be expanded in screen space;
  // collapse it rather than let it smear across the viewport.
  if (ca.w <= 1e-5 || cb.w <= 1e-5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    return;
  }
  vec2 na = ca.xy / ca.w;
  vec2 nb = cb.xy / cb.w;
  vec2 dir = (nb - na) * uViewport;
  dir = length(dir) < 1e-6 ? vec2(1.0, 0.0) : normalize(dir);
  vec2 normal = vec2(-dir.y, dir.x) / uViewport * uWidthPx;

  vec4 c = mix(ca, cb, aCorner.x);
  vec2 nd = mix(na, nb, aCorner.x) + normal * aCorner.y;
  gl_Position = vec4(nd * c.w, c.z, c.w);

  vec3 p = mix(wa, wb, aCorner.x);
  // Dim whatever faces away from the camera: depth cue without occlusion.
  // The ruler opts out — it lies in the screen plane, so the facing test
  // sits near zero along its whole length and would halve its contrast.
  float facing = dot(normalize(p + 1e-6), normalize(uEye - p));
  float dim = mix(0.3, 1.0, smoothstep(-0.25, 0.25, facing));
  vAlpha = aWeight * mix(1.0, dim, uFacingDim);
}`;

const LINE_FS = `#version 300 es
precision highp float;
in float vAlpha;
uniform vec3 uColor;
uniform float uAlpha;
out vec4 outColor;
void main() { outColor = vec4(uColor, vAlpha * uAlpha); }`;

const GREY = [0.62, 0.63, 0.68];
const RULER_GREY = [0.90, 0.91, 0.95];
const HALO = [0, 0, 0];
const MERIDIAN_STEP = 30;                    // degrees
const PARALLELS = [-60, -30, 0, 30, 60];     // declination, degrees
const RA_LABELS = [0, 60, 120, 180, 240, 300];
const SEGMENTS = 120;

const GRATICULE_PX = 1.7;
const SILHOUETTE_PX = 2.2;
const RULER_PX = 1.8;
const RULER_HALO_PX = 4.0;  // black casing, so the axis reads over points
const TICK_PX = 9;          // tick length, screen pixels

const rad = (d) => d * Math.PI / 180;
const sphere = (raDeg, decDeg) => {
  const l = rad(raDeg);
  const p = rad(decDeg);
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
};

/** Instanced line segments: one quad each, expanded in screen space. */
class LineBatch {
  constructor(gl, prog, dynamic = false) {
    this.gl = gl;
    this.count = 0;
    this.instances = gl.createBuffer();
    this.usage = dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, LineBatch.corners(gl));
    const aCorner = gl.getAttribLocation(prog, 'aCorner');
    gl.enableVertexAttribArray(aCorner);
    gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    const stride = 7 * 4;
    for (const [name, size, offset] of [['aA', 3, 0], ['aB', 3, 12], ['aWeight', 1, 24]]) {
      const loc = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
  }

  static corners(gl) {
    if (!gl._lineCorners) {
      gl._lineCorners = buffer(gl, new Float32Array([
        0, -1, 0, 1, 1, -1, 1, 1,
      ]));
    }
    return gl._lineCorners;
  }

  /** `segs` is a flat [ax,ay,az, bx,by,bz, weight] per segment. */
  upload(segs) {
    const gl = this.gl;
    this.count = segs.length / 7;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(segs), this.usage);
  }

  draw() {
    if (!this.count) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
  }
}

export class Scene {
  constructor(gl, overlay) {
    this.gl = gl;
    this.prog = program(gl, LINE_VS, LINE_FS, 'lines');
    this.labels = new Labels(overlay);

    this.graticule = new LineBatch(gl, this.prog);
    this.graticule.upload(buildGraticule());
    // Silhouette and ruler both depend on the camera, so they are rebuilt
    // every frame; they are separate batches only because they differ in
    // thickness and in whether they scale with the shell.
    this.limb = new LineBatch(gl, this.prog, true);
    this.ruler = new LineBatch(gl, this.prog, true);
  }

  /**
   * @param view    {viewProj, width, height, cssWidth, cssHeight}
   * @param camera  FlyCamera
   * @param frame   {innerRadius, outerRadius, ticks:[{radius,label}], unit}
   */
  draw(view, camera, frame) {
    const gl = this.gl;
    const eye = camera.eye;
    const basis = camera.basis();

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.prog);
    gl.uniform3fv(this.prog.u.uColor, GREY);
    gl.uniform2f(this.prog.u.uViewport, view.width, view.height);

    // Graticule: authored on the unit sphere, scaled to the inner shell,
    // and turned by the sphere's own rotation. Its facing test therefore
    // needs the eye in the sphere's frame, not the world's.
    gl.uniformMatrix4fv(this.prog.u.uViewProj, false, view.viewProjModel);
    gl.uniform3fv(this.prog.u.uEye, view.model.toLocal(eye));
    gl.uniform1f(this.prog.u.uFacingDim, 1.0);
    gl.uniform1f(this.prog.u.uScale, frame.innerRadius);
    gl.uniform1f(this.prog.u.uAlpha, 0.55);
    gl.uniform1f(this.prog.u.uWidthPx, GRATICULE_PX * view.dpr);
    this.graticule.draw();

    // Everything below is built in world space: the silhouette of a
    // sphere does not care how the sphere is spun, and the ruler must
    // not spin with it.
    gl.uniformMatrix4fv(this.prog.u.uViewProj, false, view.viewProj);
    gl.uniform3fv(this.prog.u.uEye, eye);
    gl.uniform1f(this.prog.u.uScale, 1.0);

    this.limb.upload(this._limbSegments(eye, frame));
    gl.uniform1f(this.prog.u.uAlpha, 0.8);
    gl.uniform1f(this.prog.u.uWidthPx, SILHOUETTE_PX * view.dpr);
    this.limb.draw();

    // The ruler is drawn twice: a black casing, then the line inside it.
    // Depth testing is already off, so it sits over the cloud — but grey
    // on a bright point is still grey on a bright point without this.
    this.ruler.upload(this._rulerSegments(camera, view, frame, basis));
    gl.uniform1f(this.prog.u.uFacingDim, 0.0);
    gl.uniform3fv(this.prog.u.uColor, HALO);
    gl.uniform1f(this.prog.u.uAlpha, 0.9);
    gl.uniform1f(this.prog.u.uWidthPx, RULER_HALO_PX * view.dpr);
    this.ruler.draw();
    gl.uniform3fv(this.prog.u.uColor, RULER_GREY);
    gl.uniform1f(this.prog.u.uAlpha, 1.0);
    gl.uniform1f(this.prog.u.uWidthPx, RULER_PX * view.dpr);
    this.ruler.draw();

    this._layoutLabels(view, eye, frame, basis);
  }

  /**
   * True silhouette of the shell: the circle where the tangent cone from
   * the eye touches the sphere. Its plane is normal to the centre-to-eye
   * line — not to the view direction, which no longer points at the
   * centre once the camera can be flown off-axis.
   */
  _limbSegments(eye, frame) {
    const segs = [];
    const R = frame.innerRadius;
    const d = Math.hypot(eye[0], eye[1], eye[2]);
    if (d <= R * 1.02) return segs;

    const n = m4.scale(eye, 1 / d);
    const aux = Math.abs(n[2]) > 0.99 ? [1, 0, 0] : [0, 0, 1];
    const u = m4.normalize(m4.cross(aux, n));
    const v = m4.cross(n, u);
    const r = R * Math.sqrt(d * d - R * R) / d;   // silhouette radius
    const off = (R * R) / d;                       // its plane, toward the eye

    let prev = null;
    for (let i = 0; i <= SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const p = [
        u[0] * c * r + v[0] * s * r + n[0] * off,
        u[1] * c * r + v[1] * s * r + n[1] * off,
        u[2] * c * r + v[2] * s * r + n[2] * off,
      ];
      if (prev) segs.push(...prev, ...p, 1);
      prev = p;
    }
    return segs;
  }

  /**
   * The radial ruler: sphere centre out to the edge of the data, laid
   * along the camera's right vector so it is horizontal on screen and
   * stays horizontal however the view is rotated. It lies in the screen
   * plane, so it never foreshortens and its length tracks the data scale.
   * Tick marks are a fixed number of screen pixels at any zoom.
   */
  _rulerSegments(camera, view, frame, basis) {
    const { right, up } = basis;
    const segs = [];
    const along = (t) => [right[0] * t, right[1] * t, right[2] * t];

    segs.push(0, 0, 0, ...along(frame.outerRadius), 0.7);

    for (const t of frame.ticks) {
      const base = along(t.radius);
      const len = TICK_PX * camera.worldPerPixel(base, view.height) * view.dpr;
      segs.push(...base,
        base[0] - up[0] * len, base[1] - up[1] * len, base[2] - up[2] * len, 1);
    }
    return segs;
  }

  _layoutLabels(view, eye, frame, basis) {
    const items = [];
    // Coordinate labels live in the sphere's frame, so the visibility
    // tests are done there and only the final anchor comes back out.
    const eyeDir = m4.normalize(view.model.toLocal(eye));
    const anchor = (d) => view.model.toWorld(m4.scale(d, frame.innerRadius));

    // Right ascension around the equator, near side only — a label on the
    // far side of a hollow sphere reads as belonging to the near side.
    // Offsets grow with the type size so bigger labels do not collide
    // with the very lines they annotate.
    const gap = 10 + view.labelPx * 0.5;
    const below = 12 + view.labelPx * 0.9;

    // Near side only — a label on the far side of a hollow sphere reads
    // as belonging to the near side. The tolerance is slightly negative
    // so anything sitting on the silhouette still counts, which is the
    // whole equator when looking straight down the pole.
    const nearSide = (d) => m4.dot(d, eyeDir) >= -0.02;

    for (const ra of RA_LABELS) {
      const d = sphere(ra, 0);
      if (!nearSide(d)) continue;
      items.push({ text: `${ra}°`, pos: anchor(d), radialPx: gap });
    }

    // Declination along whichever meridian currently faces the camera.
    // Filtered the same way: from directly overhead, +60 and -60 project
    // to the same ring and would otherwise be printed on top of one
    // another. Every parallel survives this test from a side-on view.
    const raFacing = Math.atan2(eyeDir[1], eyeDir[0]) * 180 / Math.PI;
    for (const dec of PARALLELS) {
      const d = sphere(raFacing, dec);
      if (!nearSide(d)) continue;
      items.push({
        text: `${dec > 0 ? '+' : ''}${dec}°`,
        pos: anchor(d),
        radialPx: gap,
        dim: true,
      });
    }

    const along = (t) => m4.scale(basis.right, t);
    for (const t of frame.ticks) {
      items.push({ text: t.label, pos: along(t.radius), offsetPx: [0, below], accent: true });
    }
    items.push({
      text: frame.unit,
      pos: along(frame.outerRadius),
      offsetPx: [view.labelPx * 1.4, 0],
      accent: true,
    });

    this.labels.render(items, view);
  }
}

function buildGraticule() {
  const segs = [];
  const push = (a, b, w) => segs.push(...a, ...b, w);

  for (let ra = 0; ra < 360; ra += MERIDIAN_STEP) {
    const w = ra === 0 ? 1.0 : 0.6;
    let prev = sphere(ra, -90);
    for (let i = 1; i <= SEGMENTS; i++) {
      const p = sphere(ra, -90 + (180 * i) / SEGMENTS);
      push(prev, p, w);
      prev = p;
    }
  }

  for (const dec of PARALLELS) {
    const w = dec === 0 ? 1.0 : 0.6;
    let prev = sphere(0, dec);
    for (let i = 1; i <= SEGMENTS; i++) {
      const p = sphere((360 * i) / SEGMENTS, dec);
      push(prev, p, w);
      prev = p;
    }
  }
  return segs;
}

/**
 * Projects 3D anchors to screen and parks reusable DOM nodes on them.
 * Offsets are applied in screen pixels, so label placement — like the
 * label text itself — is the same size at every zoom.
 */
class Labels {
  constructor(root) {
    this.root = root;
    this.pool = [];
  }

  render(items, view) {
    const project = (p) => {
      const c = m4.transform(view.viewProj, p);
      if (c[3] <= 0) return null;
      return [
        (c[0] / c[3] * 0.5 + 0.5) * view.cssWidth,
        (1 - (c[1] / c[3] * 0.5 + 0.5)) * view.cssHeight,
      ];
    };
    const centre = project([0, 0, 0]);

    let used = 0;
    for (const it of items) {
      const s = project(it.pos);
      if (!s) continue;
      let [x, y] = s;
      if (it.radialPx && centre) {
        const dx = x - centre[0];
        const dy = y - centre[1];
        const len = Math.hypot(dx, dy);
        if (len > 1e-3) {
          x += (dx / len) * it.radialPx;
          y += (dy / len) * it.radialPx;
        }
      }
      if (it.offsetPx) {
        x += it.offsetPx[0];
        y += it.offsetPx[1];
      }
      if (x < -80 || y < -40 || x > view.cssWidth + 80 || y > view.cssHeight + 40) continue;

      let el = this.pool[used];
      if (!el) {
        el = document.createElement('div');
        el.className = 'label';
        this.root.appendChild(el);
        this.pool.push(el);
      }
      el.textContent = it.text;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
      el.style.opacity = it.dim ? '0.55' : it.accent ? '0.9' : '0.75';
      el.style.display = '';
      used++;
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].style.display = 'none';
  }
}
