// The source cloud, and the screen-space collation that merges sources
// which are too close together to be told apart at the current zoom.
//
// Three passes per frame when collation is on:
//
//   1. bin    every source is rasterised as a 1-pixel point into an
//             off-screen grid whose texels are `cellPx` screen pixels
//             across. Additive blending accumulates, per texel, a count
//             and a depth sum. Each footprint owns one RGBA channel, so
//             four footprints are counted independently in one pass and
//             never merge into each other.
//
//   2. raw    the sources are drawn normally, except that each one looks
//             up its own texel and drops out if that texel holds two or
//             more sources of its footprint — those are the ones that
//             cannot be resolved, and pass 3 speaks for them.
//
//   3. blobs  one point per (texel, footprint) with a count of two or
//             more, placed at the texel centre, at the mean depth of the
//             sources it stands for, with **area proportional to that
//             count**. Diameter therefore goes as sqrt(count).
//
// With collation off only pass 2 runs, unfiltered. Zoomed far enough in
// every texel holds at most one source, so the two modes converge — which
// is the point: collation only ever redraws what you could not have seen.

import { program, buffer } from './glutil.js';

const LUT_N = 65;          // radial-mapping lookup, linearly interpolated
// A texel holding this many sources of one footprint is unresolvable.
// Written out as GLSL rather than interpolated: JS renders 2.0 as "2",
// which is an int literal and will not compare against a float.
const MERGE_MIN = '2.0';

// Shared by every pass that turns a stored source into a scene position.
const RADIAL = `
uniform float uLut[${LUT_N}];
float radiusAt(float t) {
  float x = clamp(t, 0.0, 1.0) * float(${LUT_N - 1});
  int i = int(floor(x));
  i = min(i, ${LUT_N - 2});
  return mix(uLut[i], uLut[i + 1], x - float(i));
}
vec3 scenePos(vec3 dir, float t) { return normalize(dir) * radiusAt(t); }
`;

const BIN_VS = `#version 300 es
precision highp float;
in vec3 aDir;
in float aZ;
uniform mat4 uViewProj;
${RADIAL}
out float vNdcZ;
void main() {
  gl_Position = uViewProj * vec4(scenePos(aDir, aZ), 1.0);
  vNdcZ = gl_Position.z / gl_Position.w;
  gl_PointSize = 1.0;
}`;

const BIN_FS = `#version 300 es
precision highp float;
in float vNdcZ;
uniform vec4 uChannel;
layout(location = 0) out vec4 oCount;
layout(location = 1) out vec4 oDepth;
void main() {
  oCount = uChannel;
  oDepth = uChannel * vNdcZ;
}`;

const RAW_VS = `#version 300 es
precision highp float;
in vec3 aDir;
in float aZ;
uniform mat4 uViewProj;
uniform vec2 uBinSize;
uniform vec4 uChannel;
uniform float uPointSize;
uniform float uCollate;
uniform highp sampler2D uCount;
${RADIAL}
void main() {
  vec4 clip = uViewProj * vec4(scenePos(aDir, aZ), 1.0);
  gl_Position = clip;
  gl_PointSize = uPointSize;
  if (uCollate > 0.5 && clip.w > 0.0) {
    // The same texel the rasteriser picked in the binning pass: a
    // 1-pixel point lands in the texel containing its NDC centre.
    vec2 ndc = clip.xy / clip.w;
    ivec2 texel = ivec2(floor((ndc * 0.5 + 0.5) * uBinSize));
    texel = clamp(texel, ivec2(0), ivec2(uBinSize) - 1);
    if (dot(texelFetch(uCount, texel, 0), uChannel) >= ${MERGE_MIN}) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);  // clipped away
      gl_PointSize = 0.0;
    }
  }
}`;

const BLOB_VS = `#version 300 es
precision highp float;
uniform vec2 uBinSize;
uniform vec4 uChannel;
uniform float uCellPx;
uniform float uSizeScale;
uniform float uMaxSize;
uniform highp sampler2D uCount;
uniform highp sampler2D uDepth;
void main() {
  int w = int(uBinSize.x);
  ivec2 texel = ivec2(gl_VertexID % w, gl_VertexID / w);
  float c = dot(texelFetch(uCount, texel, 0), uChannel);
  if (c < ${MERGE_MIN}) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  float ndcZ = dot(texelFetch(uDepth, texel, 0), uChannel) / c;
  vec2 ndc = ((vec2(texel) + 0.5) / uBinSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc, ndcZ, 1.0);
  gl_PointSize = min(uMaxSize, uCellPx * uSizeScale * sqrt(c));
}`;

// One sprite shader for both the raw points and the merged blobs: a disc
// with a one-pixel-ish soft rim so nothing looks like a square.
const SPRITE_FS = `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform float uAlpha;
out vec4 outColor;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d2 = dot(q, q);
  if (d2 > 0.25) discard;
  outColor = vec4(uColor, uAlpha * smoothstep(0.25, 0.15, d2));
}`;

export class PointCloud {
  constructor(gl, meta, dirBuf, zBuf) {
    this.gl = gl;
    this.meta = meta;
    this.n = meta.n;

    this.binProg = program(gl, BIN_VS, BIN_FS, 'bin');
    this.rawProg = program(gl, RAW_VS, SPRITE_FS, 'raw');
    this.blobProg = program(gl, BLOB_VS, SPRITE_FS, 'blob');

    this.dirBuf = buffer(gl, new Int16Array(dirBuf));
    this.zBuf = buffer(gl, new Uint16Array(zBuf));
    this.vaos = {
      bin: this._vao(this.binProg),
      raw: this._vao(this.rawProg),
    };
    this.emptyVao = gl.createVertexArray();

    this.maxPointSize = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
    this.binW = 0;
    this.binH = 0;
    this._initTargets();
  }

  _vao(prog) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const aDir = gl.getAttribLocation(prog, 'aDir');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dirBuf);
    gl.enableVertexAttribArray(aDir);
    gl.vertexAttribPointer(aDir, 3, gl.SHORT, true, 0, 0);
    const aZ = gl.getAttribLocation(prog, 'aZ');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.zBuf);
    gl.enableVertexAttribArray(aZ);
    gl.vertexAttribPointer(aZ, 1, gl.UNSIGNED_SHORT, true, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  /** Float render targets are what make the count/depth accumulation work. */
  _initTargets() {
    const gl = this.gl;
    this.canCollate = false;
    if (!gl.getExtension('EXT_color_buffer_float')) {
      this.collateError = 'EXT_color_buffer_float unavailable';
      return;
    }
    if (!gl.getExtension('EXT_float_blend')) {
      this.collateError = 'EXT_float_blend unavailable';
      return;
    }
    this.canCollate = true;
    this.fbo = gl.createFramebuffer();
    this.countTex = gl.createTexture();
    this.depthTex = gl.createTexture();
    for (const tex of [this.countTex, this.depthTex]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    // Give the textures storage straight away: the raw pass keeps the
    // count texture bound even with collation off, and sampling an
    // incomplete texture is an error even when the sample is unreachable.
    this._resizeBins(1, 1);
  }

  _resizeBins(w, h) {
    if (w === this.binW && h === this.binH) return;
    const gl = this.gl;
    this.binW = w;
    this.binH = h;
    for (const tex of [this.countTex, this.depthTex]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.countTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.depthTex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** `lut` is LUT_N scene radii sampled uniformly over the stored z range. */
  setRadialLut(lut) {
    this.lut = lut;
  }

  /**
   * @param view      {viewProj, width, height} of the drawing buffer
   * @param opts      visible[], colors[][], collate, cellPx, pointPx,
   *                  blobScale, maxBlobPx
   * @returns         true if the merged-blob pass ran this frame
   */
  draw(view, opts) {
    const gl = this.gl;
    const fps = this.meta.footprints;
    const collate = opts.collate && this.canCollate;

    if (collate) {
      const w = Math.max(1, Math.ceil(view.width / opts.cellPx));
      const h = Math.max(1, Math.ceil(view.height / opts.cellPx));
      this._resizeBins(w, h);
      this._binPass(view, fps, opts);
    }

    // Raw sources: depth-tested and opaque, so the near side of the shell
    // occludes the far side and the 3D structure actually reads as 3D.
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const raw = this.rawProg;
    gl.useProgram(raw);
    gl.bindVertexArray(this.vaos.raw);
    gl.uniformMatrix4fv(raw.u.uViewProj, false, view.viewProjModel);
    gl.uniform1fv(raw.u.uLut, this.lut);
    gl.uniform1f(raw.u.uPointSize, opts.pointPx);
    gl.uniform1f(raw.u.uAlpha, 1.0);
    gl.uniform1f(raw.u.uCollate, collate ? 1 : 0);
    if (this.canCollate) {
      gl.uniform2f(raw.u.uBinSize, this.binW, this.binH);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.countTex);
      gl.uniform1i(raw.u.uCount, 0);
    }
    for (let i = 0; i < fps.length; i++) {
      if (!opts.visible[i]) continue;
      gl.uniform4fv(raw.u.uChannel, channelMask(i));
      gl.uniform3fv(raw.u.uColor, opts.colors[i]);
      gl.drawArrays(gl.POINTS, fps[i].offset, fps[i].count);
    }

    if (!collate) {
      gl.bindVertexArray(null);
      return false;
    }
    this._blobPass(fps, opts);
    return true;
  }

  _binPass(view, fps, opts) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.binW, this.binH);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    const p = this.binProg;
    gl.useProgram(p);
    gl.bindVertexArray(this.vaos.bin);
    gl.uniformMatrix4fv(p.u.uViewProj, false, view.viewProjModel);
    gl.uniform1fv(p.u.uLut, this.lut);
    for (let i = 0; i < fps.length; i++) {
      if (!opts.visible[i]) continue;
      gl.uniform4fv(p.u.uChannel, channelMask(i));
      gl.drawArrays(gl.POINTS, fps[i].offset, fps[i].count);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, view.width, view.height);
    gl.clearColor(0, 0, 0, 1);
  }

  _blobPass(fps, opts) {
    const gl = this.gl;
    const p = this.blobProg;
    gl.useProgram(p);
    gl.bindVertexArray(this.emptyVao);
    gl.uniform2f(p.u.uBinSize, this.binW, this.binH);
    gl.uniform1f(p.u.uCellPx, opts.cellPx);
    gl.uniform1f(p.u.uSizeScale, opts.blobScale);
    gl.uniform1f(p.u.uMaxSize, Math.min(opts.maxBlobPx, this.maxPointSize));
    gl.uniform1f(p.u.uAlpha, 0.95);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.countTex);
    gl.uniform1i(p.u.uCount, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.uniform1i(p.u.uDepth, 1);

    const cells = this.binW * this.binH;
    for (let i = 0; i < fps.length; i++) {
      if (!opts.visible[i]) continue;
      gl.uniform4fv(p.u.uChannel, channelMask(i));
      gl.uniform3fv(p.u.uColor, opts.colors[i]);
      gl.drawArrays(gl.POINTS, 0, cells);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
  }
}

const MASKS = [
  new Float32Array([1, 0, 0, 0]),
  new Float32Array([0, 1, 0, 0]),
  new Float32Array([0, 0, 1, 0]),
  new Float32Array([0, 0, 0, 1]),
];

function channelMask(i) {
  return MASKS[i];
}

export { LUT_N };
