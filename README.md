# desiview

**desiview** is a 3D map of the DESI DR1 QSO source distribution, opening a self-contained browser interface that draws all 1,223,391 quasars at once.  Sky position places a source on a sphere, redshift places it along the radius, and colour is imaging footprint.  Built for the quasar sample used in [desi-dipole](https://github.com/strykowski-lab/desi-dipole), and accepts any catalogue with the same columns.

Since the sample starts at z = 0.8 the sphere is hollow out to there, carrying a sparse graticule, and the sources fill the shell beyond it.

---

## Installation

```bash
git clone https://github.com/strykowski-lab/desiview.git
cd desiview
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

Only `numpy` and `astropy` are needed — the renderer is raw WebGL2 with no
libraries and no CDN, so there is nothing to install for the browser side.

---

## Quick start

```python
from desiview import view

view()                                   # finds the catalogue, opens a browser
view('/path/to/desi_dr1_qso_regions.fits')
view(zmin=1.6, zmax=2.1)                 # pack a narrower shell
```

Or from the command line:

```bash
desiview                                 # same, with the catalogue found for you
desiview /path/to/desi_dr1_qso_regions.fits --port 9000
desiview --prepare-only                  # pack the catalogue without serving
```

The catalogue is packed on first use and re-packed whenever it changes.
Both forms start a local HTTP server and block until interrupted (`Ctrl+C`).

### Finding the catalogue

With no path given, desiview looks at `$DESIVIEW_CATALOG`, then the working
directory, then a sibling `datastore/` — the layout desi-dipole uses.  Packed
binaries go to `~/.cache/desiview`, or `$DESIVIEW_CACHE`.

---

## API

```python
view(catalog=None, cache=None, zmin=0.8, zmax=3.5, port=8412,
     browser=True, rebuild=False, quiet=False)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `catalog` | `str` or `Path` | DESI QSO regions catalogue. Located automatically when omitted — see above. |
| `cache` | `str` or `Path` | Where packed binaries live. Defaults to `~/.cache/desiview`, or `$DESIVIEW_CACHE`. |
| `zmin`, `zmax` | `float` | Redshift range to pack. Default `0.8`–`3.5`, desi-dipole's widest working range. |
| `port` | `int` | Port to serve on. Default `8412`. |
| `browser` | `bool` | Open the system browser automatically. Default `True`. |
| `rebuild` | `bool` | Re-pack even if the cache is already current. Default `False`. |
| `quiet` | `bool` | Suppress progress output. Default `False`. |

```python
prepare(catalog=None, cache=None, zmin=0.8, zmax=3.5, quiet=False)
```

Packs the catalogue and returns the cache directory, without serving anything.
`view` calls it for you; call it directly to pre-build a cache.

### Input catalogue

A FITS binary table with `RA`, `DEC`, `Z` and `IMAGING_REGION`, which is what
desi-dipole's `assign_imaging_region.py` writes to
`desi_dr1_qso_regions.fits`.  `IMAGING_REGION` must hold the four-way
`regressis` DESI imaging split; rows in any other region are dropped with a
warning.

| Footprint | Sources | Colour |
|-----------|--------:|--------|
| North | 226,529 | blue |
| DECaLS NGC | 566,690 | orange |
| DECaLS SGC | 315,370 | green |
| DES | 114,802 | purple |

Colours are Okabe-Ito, which stay distinguishable on black and survive the
common forms of colour blindness.

---

## Viewer controls

### Navigation

| Action | Effect |
|--------|--------|
| Drag | Turn the sphere; the point under the cursor follows it |
| Scroll | Dolly along the view axis |
| `W` `A` `S` `D` | Fly forward / left / back / right |
| `space` / `ctrl` | Up / down |
| `shift` | Sprint (4×), held with any of the above |
| `E` | Toggle mouse look on and off — starts **off** |
| Move the mouse | With mouse look on: turn the camera in place |

The camera and the sphere rotate independently, which is the point.  **The
sphere** carries its own orientation: dragging turns it about its own centre
and the camera does not move.  Turning it by orbiting the camera instead only
looks right while the camera is pointed at the centre, and swings the sphere
across the view once you have flown off with `WASD`.  **The camera** is a free
flyer with a level horizon.

Mouse look starts off because otherwise every trip across the canvas to reach
the controls turns the view.  Movement speed scales with how far out you are,
so flying feels the same near the shell as far from it.

> **Note.** `ctrl`+`W` closes the tab — browsers reserve it and a page cannot
> suppress it — so `C` is bound to *down* as well, for descending while moving
> forward.

### Panel

| Control | Effect |
|---------|--------|
| Footprint toggles | Show or hide each imaging region independently |
| Merge unresolvable sources | Collation on/off — see below |
| Cell size | How aggressively sources merge, in screen pixels |
| Merged size | Scales the merged points |
| Point size | Screen size of an individual source |
| Label size | Type size for the coordinate and redshift labels |
| Mouse look | Readout and click target for the `E` toggle |
| radius = redshift / comoving distance | Radial coordinate — see below |
| Top view | Turn the sphere pole-on to where you are |
| Reset view | Camera and sphere orientation back to the opening view |
| Reset settings | Sliders, toggles and footprints back to defaults, leaving the view alone |

---

## Collation

Zoomed out, most sources land on top of each other and the display stops being
honest about density: a saturated patch looks the same whether it holds ten
sources or ten thousand.  With **Merge unresolvable sources** on, sources that
cannot be told apart at the current zoom are replaced by a single point whose
*area is proportional to how many it stands for*.

It works in screen space, so it tracks zoom and perspective exactly rather than
approximating them:

1. Every source is rasterised as a one-pixel point into an off-screen grid whose
   cells are *Cell size* screen pixels across.  Additive blending accumulates a
   count and a depth sum per cell.  **Each footprint owns one RGBA channel**, so
   the four are counted independently and never merge into one another.
2. The sources are drawn normally, except each one looks up its own cell and
   drops out if that cell holds two or more sources *of its own footprint* —
   exactly the ones you could not have resolved.
3. One merged point is drawn per (cell, footprint) with a count of two or more,
   at the cell centre, at the mean depth of the sources it replaces, with
   diameter ∝ √count.

Zoom in far enough and every cell holds at most one source, so the two modes
converge — collation only ever redraws what you could not have seen.

Needs `EXT_color_buffer_float` and `EXT_float_blend`.  If either is missing the
toggle disables itself and says which.

---

## Radial coordinate

Default is **radius = redshift**, as the ticked radial ruler reads.  The
alternative maps radius to **comoving distance** (Planck18 flat ΛCDM), which is
what the shell actually looks like in space — the low-z sources move outward and
the sample looks considerably less deep.  Both put the outermost sources at the
same scene radius, so switching rescales the shell rather than the view, and the
ruler stays labelled in z either way.

The ruler runs from the sphere centre along the camera's right vector, so it is
horizontal on screen and stays horizontal however you turn the sphere.  It lies
in the screen plane, so it never foreshortens and its projected length tracks the
data scale.  Tick marks and label offsets are sized in screen pixels, so the
annotation stays put while the data zooms.

---

## Implementation notes

The renderer is raw WebGL2 — no libraries, no CDN, nothing to install beyond
what the packing needs.  A million-point cloud is a single GPU buffer and a
couple of draw calls, so the browser is not a compromise here: it is the
shortest path to a shader that can do the collation above, and it gets a real
GPU on every machine you might want to look at this from.  Everything is served
from `localhost`; nothing leaves the machine.

Sources are stored as an int16 unit sky vector plus a uint16 redshift — 9.8 MB
for the full sample, accurate to 5 arcsec and Δz = 2×10⁻⁵, both far below a
pixel at any zoom.  Rows are sorted by footprint at prep time so each one is a
contiguous range of the vertex buffer: toggling a footprint off skips its draw
call rather than filtering anything.  The radial mapping is a 65-entry lookup
evaluated in the vertex shader, so switching it re-uploads nothing.

Sphere-attached geometry — the sources and the graticule — is drawn through the
sphere's model rotation, while the silhouette and the ruler stay in world space
and never spin with the data.  Coordinate labels are tested for visibility in
the sphere's own frame and only their final anchors come back out.  Lines are
screen-space expanded quads rather than `GL_LINES`, because WebGL clamps
`lineWidth` to 1 on essentially every desktop driver.

```
desiview/prepare.py         catalogue -> {dir,z}.bin + meta.json
desiview/viewer.py          view(); local static server
desiview/cli.py             the `desiview` command
desiview/templates/js/
  points.js                 the source cloud and the three collation passes
  scene.js                  shell graticule, silhouette, radial ruler, labels
  camera.js                 free-flying camera, mouse look
  model.js                  the sphere's own orientation
  app.js                    controls and frame loop
```

---

## Citation

If you use `desiview` in your research, please include a footnote to the repository:

> [https://github.com/strykowski-lab/desiview](https://github.com/strykowski-lab/desiview)

BibTeX:

```bibtex
@software{desiview,
  author       = {Land-Strykowski, Mali},
  title        = {desiview: 3D viewer for the DESI DR1 QSO source distribution},
  url          = {https://github.com/strykowski-lab/desiview},
  version      = {0.1.0},
  year         = {2026},
}
```

---

## License

MIT
