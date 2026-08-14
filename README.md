# desiview

A 3D map of the DESI DR1 QSO source distribution — the sample from
[`desi-dipole`](../desi-dipole), all 1,223,391 quasars at once.

Sky position places a source on a sphere; redshift places it along the
radius. Since the sample starts at z = 0.8 the sphere is hollow out to
there, carrying a sparse graticule, and the sources fill the shell beyond
it. Colour is imaging footprint.

## Controls

| | |
|---|---|
| drag | turn the sphere; the point under the cursor follows it |
| `E` | toggle mouse look on/off (starts **off**) |
| move the mouse | with mouse look on: turn the camera in place |
| scroll | dolly along the view axis |
| `W`/`A`/`S`/`D` | fly forward / left / back / right |
| `space` / `ctrl` | up / down |
| `shift` | sprint (4×), held with any of the above |
| Top view | turn the sphere pole-on to where you are |

Movement speed scales with the orbit radius, so it feels the same whether
you are outside the shell or flying through it. **`ctrl`+`W` closes the
tab** — browsers reserve it and a page cannot suppress it — so `C` is
bound to *down* as well, for descending while moving forward.

The camera and the sphere rotate independently, which is the point.

**The sphere** carries its own orientation quaternion. Dragging turns it
about its own centre, on an axis perpendicular to the drag in *screen*
space, and the camera does not move at all. The tumble is free — no pole
clamp, no gimbal lock. Turning the sphere by orbiting the camera instead
would only look right while the camera is pointed at the centre; once you
have flown off with WASD, orbiting swings the sphere across the view
rather than spinning it in place.

**The camera** is a free flyer with yaw and pitch, no roll: the horizon
stays level, which is what makes flying navigable. Moving the mouse looks
around, but only while mouse look is on — it starts off, because
otherwise every trip across the canvas to reach the controls turns the
view. Tap `E` to toggle it; the panel checkbox is a readout of the same
state and works too.

So sphere-attached geometry — the sources and the graticule — is drawn
through the model rotation, while the silhouette and the ruler stay in
world space and never spin with the data. Coordinate labels are tested
for visibility in the sphere's own frame and only their final anchors
come back out to world space.

## Run

```bash
source /Users/mali/repos/dipoletools/.venv/bin/activate
python3 prepare.py        # once, or whenever the catalogue changes
python3 serve.py          # opens http://localhost:8412/
```

`prepare.py` reads `../datastore/desi_dr1_qso_regions.fits` and writes
~10 MB of packed binaries into `web/data/` (gitignored). Both scripts need
only numpy and astropy.

## Why a browser

The renderer is raw WebGL2 — no libraries, no CDN, nothing to install
beyond what the prep scripts already need. A million-point cloud is a
single GPU buffer and a couple of draw calls, so the browser is not a
compromise here: it is the shortest path to a shader that can do the
collation below, and it gets a real GPU on every machine you might want to
look at this from. Everything is served from `localhost`; nothing leaves
the machine.

## Footprints

The four-way `regressis` DESI imaging split that Methods F–I use, read
straight from `IMAGING_REGION`:

| Footprint | Sources | Colour |
|---|---:|---|
| North | 226,529 | blue |
| DECaLS NGC | 566,690 | orange |
| DECaLS SGC | 315,370 | green |
| DES | 114,802 | purple |

Each is toggled independently. Rows are sorted by footprint at prep time
so each one is a contiguous range of the vertex buffer — toggling one off
skips its draw call rather than filtering anything.

## Collation

Zoomed out, most sources land on top of each other and the display stops
being honest about density: a saturated patch looks the same whether it
holds ten sources or ten thousand. With **Merge unresolvable sources** on,
sources that cannot be told apart at the current zoom are replaced by a
single point whose *area is proportional to how many it stands for*.

It works in screen space, so it tracks zoom and perspective exactly rather
than approximating them:

1. Every source is rasterised as a one-pixel point into an off-screen grid
   whose cells are *Cell size* screen pixels across. Additive blending
   accumulates a count and a depth sum per cell. **Each footprint owns one
   RGBA channel**, so the four are counted independently and never merge
   into one another.
2. The sources are drawn normally, except each one looks up its own cell
   and drops out if that cell holds two or more sources *of its own
   footprint* — those are exactly the ones you could not have resolved.
3. One merged point is drawn per (cell, footprint) with a count of two or
   more, at the cell centre, at the mean depth of the sources it replaces,
   with diameter ∝ √count.

Zoom in far enough and every cell holds at most one source, so the two
modes converge — collation only ever redraws what you could not have seen.
*Merged size* scales the blobs; *Cell size* sets how aggressive the
merging is.

Needs `EXT_color_buffer_float` and `EXT_float_blend`. If either is
missing, the toggle disables itself and says which.

## Radial coordinate

Default is **radius = redshift**, as the ticked radial ruler reads. The
alternative maps radius to **comoving distance** (Planck18 flat ΛCDM),
which is what the shell actually looks like in space — the low-z sources
move outward and the sample looks considerably less deep. Both put the
outermost sources at the same scene radius, so switching rescales the
shell rather than the view, and the ruler stays labelled in z either way.

The ruler runs from the sphere centre along the camera's right vector, so
it is horizontal on screen and stays horizontal however you rotate. It
lies in the screen plane, so it never foreshortens and its projected
length tracks the data scale. Tick marks and every label offset are sized
in screen pixels, so the annotation stays put while the data zooms.

Lines are drawn as screen-space expanded quads, not `GL_LINES` — WebGL
clamps `lineWidth` to 1 on essentially every desktop driver, so a quad per
segment is the only way to get a real thickness.

## Layout

```
prepare.py          catalogue -> web/data/{dir,z}.bin + meta.json
serve.py            static server on localhost
web/js/points.js    the source cloud and the three collation passes
web/js/scene.js     shell graticule, silhouette, radial ruler, labels
web/js/camera.js    orbit camera
web/js/app.js       controls and frame loop
```

Sources are stored as an int16 unit sky vector plus a uint16 redshift —
9.8 MB for the full sample, and accurate to 5 arcsec and Δz = 2×10⁻⁵,
both far below a pixel at any zoom. The radial mapping is a 65-entry
lookup evaluated in the vertex shader, so switching it re-uploads nothing.
