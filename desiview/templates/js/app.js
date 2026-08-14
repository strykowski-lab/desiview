import { FlyCamera } from './camera.js';
import { SphereModel } from './model.js';
import { PointCloud, LUT_N } from './points.js';
import { Scene } from './scene.js';
import { hexToRgb } from './glutil.js';
import * as m4 from './mat4.js';

const MAX_DPR = 2;
const MAX_BLOB_CSS_PX = 40;

const canvas = document.getElementById('gl');
const overlay = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');

const ui = {
  collate: document.getElementById('collate'),
  cell: document.getElementById('cell'),
  point: document.getElementById('point'),
  blob: document.getElementById('blob'),
  labelsize: document.getElementById('labelsize'),
  mouselook: document.getElementById('mouselook'),
  radial: document.getElementsByName('radial'),
  topView: document.getElementById('top-view'),
  reset: document.getElementById('reset'),
  resetSettings: document.getElementById('reset-settings'),
  footprints: document.getElementById('footprints'),
};

// Everything the "Reset settings" button restores. The view is deliberately
// not included — losing your place is not what you want from that button.
const DEFAULTS = {
  collate: true, cell: 2, point: 1.5, blob: 0.8, labelsize: 11,
  mouselook: false, radial: 'z',
};

function applyLabelSize() {
  overlay.style.setProperty('--label-size', `${ui.labelsize.value}px`);
}

const state = {
  visible: [],
  colors: [],
  radial: 'z',
  needsDraw: true,
};

boot().catch((err) => {
  statusEl.textContent = String(err.message || err);
  statusEl.classList.add('error');
  console.error(err);
});

async function boot() {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: true,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 is not available in this browser.');

  statusEl.textContent = 'loading catalogue…';
  const [meta, dirBuf, zBuf] = await Promise.all([
    fetch('data/meta.json').then(r => json(r, 'data/meta.json')),
    fetch('data/dir.bin').then(r => bytes(r, 'data/dir.bin')),
    fetch('data/z.bin').then(r => bytes(r, 'data/z.bin')),
  ]);

  const camera = new FlyCamera(canvas);
  const model = new SphereModel();
  const cloud = new PointCloud(gl, meta, dirBuf, zBuf);
  const scene = new Scene(gl, overlay);

  // Dragging turns the sphere about its own centre; the camera does not
  // move. Looking around is the camera's own job, handled inside it.
  camera.onDragRotate = (dx, dy) => model.rotateScreen(dx, dy, camera.basis());
  // E is the toggle; the checkbox is its readout and works either way.
  camera.setMouseLook(ui.mouselook.checked);
  camera.onMouseLookChange = (on) => { ui.mouselook.checked = on; };

  state.visible = meta.footprints.map(() => true);
  state.colors = meta.footprints.map(f => hexToRgb(f.color));
  buildFootprintToggles(meta);

  if (!cloud.canCollate) {
    ui.collate.checked = false;
    ui.collate.disabled = true;
    document.getElementById('collate-note').textContent =
      `unavailable — ${cloud.collateError}`;
  }

  applyLabelSize();
  const inputs = [ui.collate, ui.cell, ui.point, ui.blob, ui.labelsize,
    ui.mouselook, ...ui.radial];
  for (const el of inputs) {
    el.addEventListener('input', () => {
      state.radial = [...ui.radial].find(r => r.checked).value;
      camera.mouseLook = ui.mouselook.checked;
      applyLabelSize();
      state.needsDraw = true;
    });
  }
  ui.topView.addEventListener('click', () => {
    // Turn the sphere pole-on to wherever the camera already is, rather
    // than flying the camera overhead: dragging turns the sphere, so
    // snapping should too.
    const b = camera.basis();
    model.set(m4.quatFromBasis(b.right, b.up, b.back));
    ui.topView.blur();   // else space would re-trigger it instead of flying
    state.needsDraw = true;
  });
  ui.reset.addEventListener('click', () => {
    camera.reset();
    model.reset();
    ui.reset.blur();
    state.needsDraw = true;
  });
  ui.resetSettings.addEventListener('click', () => {
    ui.resetSettings.blur();
    if (!ui.collate.disabled) ui.collate.checked = DEFAULTS.collate;
    ui.cell.value = DEFAULTS.cell;
    ui.point.value = DEFAULTS.point;
    ui.blob.value = DEFAULTS.blob;
    ui.labelsize.value = DEFAULTS.labelsize;
    ui.mouselook.checked = DEFAULTS.mouselook;
    camera.mouseLook = DEFAULTS.mouselook;
    applyLabelSize();
    for (const r of ui.radial) r.checked = r.value === DEFAULTS.radial;
    state.radial = DEFAULTS.radial;
    for (const box of ui.footprints.querySelectorAll('input')) box.checked = true;
    state.visible.fill(true);
    state.needsDraw = true;
  });

  gl.clearColor(0, 0, 0, 1);
  gl.disable(gl.CULL_FACE);

  statusEl.textContent = `${meta.n.toLocaleString()} DESI DR1 quasars · z ${meta.zmin}–${meta.zmax}`;

  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    camera.tick(dt);

    const resized = resize(gl);
    if (resized || camera.dirty || model.dirty || state.needsDraw) {
      const t0 = performance.now();
      const merged = draw(gl, camera, model, cloud, scene, meta);
      model.dirty = false;
      state.needsDraw = false;
      updateStats(meta, performance.now() - t0, merged);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame((t) => {
    last = t;
    frame(t);
  });
}

function draw(gl, camera, model, cloud, scene, meta) {
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

  const frame = radialFrame(meta, state.radial);
  cloud.setRadialLut(frame.lut);

  const viewProj = camera.update(w, h);
  const view = {
    viewProj,
    // Sphere-attached geometry — the sources and the graticule — goes
    // through the model rotation. World-space furniture (the silhouette,
    // the ruler) uses the plain matrix so it does not spin with the data.
    viewProjModel: m4.multiply(viewProj, model.matrix),
    model,
    width: w,
    height: h,
    dpr,
    cssWidth: w / dpr,
    cssHeight: h / dpr,
    labelPx: Number(ui.labelsize.value),
  };

  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const merged = cloud.draw(view, {
    visible: state.visible,
    colors: state.colors,
    collate: ui.collate.checked,
    cellPx: Number(ui.cell.value) * dpr,
    pointPx: Number(ui.point.value) * dpr,
    blobScale: Number(ui.blob.value),
    maxBlobPx: MAX_BLOB_CSS_PX * dpr,
  });

  scene.draw(view, camera, frame);
  return merged;
}

/**
 * Scene radii for the current radial mapping.
 *
 * Both mappings put the outermost sources at the same scene radius, so
 * switching between them rescales the shell rather than the whole view.
 */
function radialFrame(meta, mode) {
  const { zmin, zmax } = meta;
  const outer = zmax;
  const lut = new Float32Array(LUT_N);
  let radiusOf;

  if (mode === 'chi') {
    const chi = meta.comoving.chi;
    const chiMax = chi[chi.length - 1];
    const sampleChi = (t) => {
      const x = Math.min(Math.max(t, 0), 1) * (chi.length - 1);
      const i = Math.min(Math.floor(x), chi.length - 2);
      return chi[i] + (chi[i + 1] - chi[i]) * (x - i);
    };
    radiusOf = (t) => (sampleChi(t) / chiMax) * outer;
  } else {
    radiusOf = (t) => zmin + t * (zmax - zmin);
  }

  for (let i = 0; i < LUT_N; i++) lut[i] = radiusOf(i / (LUT_N - 1));

  const tOf = (z) => (z - zmin) / (zmax - zmin);
  const ticks = [{ z: zmin, radius: radiusOf(0), label: zmin.toFixed(1) }];
  for (let z = Math.ceil(zmin * 2) / 2 + 0.5; z <= zmax + 1e-9; z += 0.5) {
    const zr = Math.round(z * 10) / 10;
    ticks.push({ z: zr, radius: radiusOf(tOf(zr)), label: zr.toFixed(1) });
  }

  return {
    lut,
    innerRadius: radiusOf(0),
    outerRadius: outer,
    ticks,
    unit: mode === 'chi' ? 'z (comoving)' : 'z',
  };
}

function buildFootprintToggles(meta) {
  meta.footprints.forEach((f, i) => {
    const row = document.createElement('label');
    row.className = 'toggle';
    row.innerHTML = `
      <input type="checkbox" checked>
      <span class="swatch" style="background:${f.color}"></span>
      <span class="name">${f.name.replace(/_/g, ' ')}</span>
      <span class="count">${f.count.toLocaleString()}</span>`;
    row.querySelector('input').addEventListener('change', (e) => {
      state.visible[i] = e.target.checked;
      state.needsDraw = true;
    });
    ui.footprints.appendChild(row);
  });
}

function updateStats(meta, ms, merged) {
  const shown = meta.footprints
    .filter((_, i) => state.visible[i])
    .reduce((a, f) => a + f.count, 0);
  const parts = [
    `${shown.toLocaleString()} sources`,
    `${ms.toFixed(1)} ms/frame`,
  ];
  if (merged) parts.push('collating');
  statsEl.textContent = parts.join('  ·  ');
}

function resize(gl) {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (w === canvas.width && h === canvas.height) return false;
  canvas.width = w;
  canvas.height = h;
  void gl;
  return true;
}

async function json(res, what) {
  if (!res.ok) throw new Error(`${what}: ${res.status} — run prepare.py?`);
  return res.json();
}

async function bytes(res, what) {
  if (!res.ok) throw new Error(`${what}: ${res.status} — run prepare.py?`);
  return res.arrayBuffer();
}
