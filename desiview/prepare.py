"""Pack a DESI QSO catalogue into the viewer's binary format.

Writes three files into the cache directory:

    dir.bin    int16  3N   unit sky vector, x32767
    z.bin      uint16  N   redshift, quantised over [zmin, zmax]
    meta.json             counts, footprint ranges, comoving-distance LUT

Rows are sorted by imaging footprint so each footprint is one contiguous
range in both binaries. The viewer then toggles a footprint by simply not
issuing its draw call, and colours it from a uniform — no per-point
footprint attribute is stored.

The comoving-distance LUT lets the viewer switch the radial coordinate
between redshift and comoving distance without re-uploading anything.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np

# The four-way DESI imaging split that ``regressis`` defines and that
# desi-dipole's ``assign_imaging_region.py`` writes into IMAGING_REGION.
# Colours are Okabe-Ito, which stay distinguishable on black and survive
# the common forms of colour blindness.
FOOTPRINTS = [
    ("North", "#56B4E9"),
    ("DECaLS_NGC", "#E69F00"),
    ("DECaLS_SGC", "#009E73"),
    ("DES", "#CC79A7"),
]

CATALOG_NAME = "desi_dr1_qso_regions.fits"
LUT_SIZE = 512
ZMIN, ZMAX = 0.8, 3.5


def default_cache() -> Path:
    """Where packed binaries live. Override with ``$DESIVIEW_CACHE``."""
    env = os.environ.get("DESIVIEW_CACHE")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".cache" / "desiview"


def find_catalog() -> Path:
    """Locate the catalogue when the caller did not name one.

    Looks at ``$DESIVIEW_CATALOG``, then the working directory, then a
    sibling ``datastore/`` — the layout desi-dipole uses.
    """
    env = os.environ.get("DESIVIEW_CATALOG")
    if env:
        return Path(env).expanduser()

    here = Path.cwd()
    candidates = [
        here / CATALOG_NAME,
        here / "datastore" / CATALOG_NAME,
        here.parent / "datastore" / CATALOG_NAME,
    ]
    for path in candidates:
        if path.exists():
            return path
    raise FileNotFoundError(
        f"could not find {CATALOG_NAME}. Pass the path explicitly, or set "
        "DESIVIEW_CATALOG to point at it."
    )


def comoving_lut(zmin: float, zmax: float) -> dict:
    """Comoving distance on a uniform z grid spanning [zmin, zmax]."""
    try:
        from astropy.cosmology import Planck18 as cosmo
        name = "Planck18"
    except ImportError:  # older astropy
        from astropy.cosmology import FlatLambdaCDM
        cosmo = FlatLambdaCDM(H0=67.66, Om0=0.30966)
        name = "FlatLambdaCDM(H0=67.66, Om0=0.30966)"

    zs = np.linspace(zmin, zmax, LUT_SIZE)
    return {
        "cosmology": name,
        "unit": "Mpc",
        "chi": [float(v) for v in cosmo.comoving_distance(zs).value],
    }


def is_current(cache: Path, catalog: Path, zmin: float, zmax: float) -> bool:
    """True if the cache already holds this catalogue at this z range."""
    meta_path = cache / "meta.json"
    if not all((cache / f).exists() for f in ("dir.bin", "z.bin", "meta.json")):
        return False
    try:
        meta = json.loads(meta_path.read_text())
    except (OSError, ValueError):
        return False
    return (
        meta.get("source") == str(catalog)
        and meta.get("zmin") == zmin
        and meta.get("zmax") == zmax
        and meta.get("mtime") == catalog.stat().st_mtime
    )


def prepare(catalog=None, cache=None, zmin=ZMIN, zmax=ZMAX, quiet=False) -> Path:
    """Pack ``catalog`` into ``cache``. Returns the cache directory.

    Parameters
    ----------
    catalog : str or Path, optional
        The regions catalogue. Located automatically when omitted.
    cache : str or Path, optional
        Where to write. Defaults to ``~/.cache/desiview``.
    zmin, zmax : float
        Redshift range to keep. The default 0.8-3.5 matches desi-dipole's
        widest working range.
    """
    from astropy.io import fits

    catalog = Path(catalog).expanduser() if catalog else find_catalog()
    cache = Path(cache).expanduser() if cache else default_cache()
    say = (lambda *a: None) if quiet else print

    say(f"reading {catalog}")
    with fits.open(catalog) as hdul:
        d = hdul[1].data
        ra = np.asarray(d["RA"], dtype=np.float64)
        dec = np.asarray(d["DEC"], dtype=np.float64)
        z = np.asarray(d["Z"], dtype=np.float64)
        region = np.asarray(d["IMAGING_REGION"]).astype(str)

    keep = (z >= zmin) & (z <= zmax)
    ra, dec, z, region = ra[keep], dec[keep], z[keep], region[keep]
    say(f"{len(z)} rows in {zmin} <= z <= {zmax}")

    # Sort into contiguous per-footprint blocks.
    names = [n for n, _ in FOOTPRINTS]
    code = np.full(len(z), -1, dtype=np.int8)
    for i, n in enumerate(names):
        code[region == n] = i
    if np.any(code < 0):
        labels = sorted(set(region[code < 0].tolist()))
        say(f"  [warn] dropping {int(np.sum(code < 0))} rows with region {labels}")
        sel = code >= 0
        ra, dec, z, code = ra[sel], dec[sel], z[sel], code[sel]

    order = np.argsort(code, kind="stable")
    ra, dec, z, code = ra[order], dec[order], z[order], code[order]

    # Equatorial spherical -> unit cartesian. +z is the north celestial
    # pole, +x points at RA=0 on the equator, so the frame is right-handed.
    lam = np.radians(ra)
    phi = np.radians(dec)
    cphi = np.cos(phi)
    xyz = np.stack([cphi * np.cos(lam), cphi * np.sin(lam), np.sin(phi)], axis=1)

    dir_i16 = np.clip(np.rint(xyz * 32767.0), -32767, 32767).astype("<i2")
    zt = (z - zmin) / (zmax - zmin)
    z_u16 = np.clip(np.rint(zt * 65535.0), 0, 65535).astype("<u2")

    cache.mkdir(parents=True, exist_ok=True)
    (cache / "dir.bin").write_bytes(dir_i16.tobytes())
    (cache / "z.bin").write_bytes(z_u16.tobytes())

    counts = np.bincount(code, minlength=len(names))
    offsets = np.concatenate([[0], np.cumsum(counts)])[:-1]
    meta = {
        "n": int(len(z)),
        "zmin": zmin,
        "zmax": zmax,
        "source": str(catalog),
        "mtime": catalog.stat().st_mtime,
        "footprints": [
            {"name": n, "color": c, "offset": int(o), "count": int(k)}
            for (n, c), o, k in zip(FOOTPRINTS, offsets, counts)
        ],
        "comoving": comoving_lut(zmin, zmax),
    }
    (cache / "meta.json").write_text(json.dumps(meta, indent=2))

    for f in meta["footprints"]:
        say(f"  {f['name']:<12} {f['count']:>9,}")
    say(f"wrote {cache}  ({(dir_i16.nbytes + z_u16.nbytes) / 1e6:.1f} MB)")
    return cache
