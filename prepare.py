"""Pack the DESI DR1 QSO regions catalogue into the viewer's binary format.

Reads ``../datastore/desi_dr1_qso_regions.fits`` and writes three files into
``web/data/``:

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

import argparse
import json
from pathlib import Path

import numpy as np
from astropy.io import fits

REPO = Path(__file__).resolve().parent
DEFAULT_CATALOG = REPO.parent / "datastore" / "desi_dr1_qso_regions.fits"
OUT_DIR = REPO / "web" / "data"

# regressis' four-way DESI imaging split, in the order desi-dipole uses.
# Colours are Okabe-Ito, which stay distinguishable on black and survive
# the common forms of colour blindness.
FOOTPRINTS = [
    ("North", "#56B4E9"),
    ("DECaLS_NGC", "#E69F00"),
    ("DECaLS_SGC", "#009E73"),
    ("DES", "#CC79A7"),
]

LUT_SIZE = 512


def comoving_lut(zmin: float, zmax: float) -> dict:
    """Comoving distance on a uniform z grid spanning [zmin, zmax].

    Sampled from z=0 so the LUT can be normalised against the true
    distance to the origin, not just to the inner shell.
    """
    try:
        from astropy.cosmology import Planck18 as cosmo
        name = "Planck18"
    except ImportError:  # older astropy
        from astropy.cosmology import FlatLambdaCDM
        cosmo = FlatLambdaCDM(H0=67.66, Om0=0.30966)
        name = "FlatLambdaCDM(H0=67.66, Om0=0.30966)"

    zs = np.linspace(zmin, zmax, LUT_SIZE)
    chi = cosmo.comoving_distance(zs).value  # Mpc
    return {
        "cosmology": name,
        "unit": "Mpc",
        "chi": [float(v) for v in chi],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    ap.add_argument("--zmin", type=float, default=0.8)
    ap.add_argument("--zmax", type=float, default=3.5,
                    help="default matches desi-dipole zrange E")
    args = ap.parse_args()

    with fits.open(args.catalog) as hdul:
        d = hdul[1].data
        ra = np.asarray(d["RA"], dtype=np.float64)
        dec = np.asarray(d["DEC"], dtype=np.float64)
        z = np.asarray(d["Z"], dtype=np.float64)
        region = np.asarray(d["IMAGING_REGION"]).astype(str)

    keep = (z >= args.zmin) & (z <= args.zmax)
    ra, dec, z, region = ra[keep], dec[keep], z[keep], region[keep]
    print(f"{len(z)} rows in {args.zmin} <= z <= {args.zmax}")

    # Sort into contiguous per-footprint blocks.
    names = [n for n, _ in FOOTPRINTS]
    code = np.full(len(z), -1, dtype=np.int8)
    for i, n in enumerate(names):
        code[region == n] = i
    unassigned = int(np.count_nonzero(code < 0))
    if unassigned:
        labels = sorted(set(region[code < 0].tolist()))
        print(f"  [warn] dropping {unassigned} rows with region {labels}")
        sel = code >= 0
        ra, dec, z, code = ra[sel], dec[sel], z[sel], code[sel]

    order = np.argsort(code, kind="stable")
    ra, dec, z, code = ra[order], dec[order], z[order], code[order]

    # Equatorial spherical -> unit cartesian. +z is the north celestial pole,
    # +x points at RA=0 on the equator, so the frame is right-handed.
    lam = np.radians(ra)
    phi = np.radians(dec)
    cphi = np.cos(phi)
    xyz = np.stack([cphi * np.cos(lam), cphi * np.sin(lam), np.sin(phi)], axis=1)

    dir_i16 = np.clip(np.rint(xyz * 32767.0), -32767, 32767).astype("<i2")
    zt = (z - args.zmin) / (args.zmax - args.zmin)
    z_u16 = np.clip(np.rint(zt * 65535.0), 0, 65535).astype("<u2")

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "dir.bin").write_bytes(dir_i16.tobytes())
    (args.out / "z.bin").write_bytes(z_u16.tobytes())

    counts = np.bincount(code, minlength=len(names))
    offsets = np.concatenate([[0], np.cumsum(counts)])[:-1]
    meta = {
        "n": int(len(z)),
        "zmin": args.zmin,
        "zmax": args.zmax,
        "source": str(args.catalog),
        "footprints": [
            {"name": n, "color": c, "offset": int(o), "count": int(k)}
            for (n, c), o, k in zip(FOOTPRINTS, offsets, counts)
        ],
        "comoving": comoving_lut(args.zmin, args.zmax),
    }
    (args.out / "meta.json").write_text(json.dumps(meta, indent=2))

    for f in meta["footprints"]:
        print(f"  {f['name']:<12} {f['count']:>9,}")
    total_mb = (dir_i16.nbytes + z_u16.nbytes) / 1e6
    print(f"wrote {args.out}  ({total_mb:.1f} MB)")


if __name__ == "__main__":
    main()
