"""Command-line entry point: ``desiview``."""
from __future__ import annotations

import argparse

from . import __version__
from .prepare import ZMAX, ZMIN, prepare
from .viewer import DEFAULT_PORT, view


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(
        prog="desiview",
        description="3D map of the DESI DR1 QSO source distribution.",
    )
    ap.add_argument("catalog", nargs="?",
                    help="regions catalogue; found automatically when omitted")
    ap.add_argument("--cache", help="where packed binaries live "
                                    "(default ~/.cache/desiview)")
    ap.add_argument("--zmin", type=float, default=ZMIN)
    ap.add_argument("--zmax", type=float, default=ZMAX)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--no-browser", action="store_true",
                    help="do not open a browser window")
    ap.add_argument("--rebuild", action="store_true",
                    help="re-pack even if the cache is current")
    ap.add_argument("--prepare-only", action="store_true",
                    help="pack the catalogue and exit, without serving")
    ap.add_argument("--version", action="version", version=f"desiview {__version__}")
    args = ap.parse_args(argv)

    if args.prepare_only:
        prepare(args.catalog, args.cache, zmin=args.zmin, zmax=args.zmax)
        return

    view(args.catalog, args.cache, zmin=args.zmin, zmax=args.zmax,
         port=args.port, browser=not args.no_browser, rebuild=args.rebuild)


if __name__ == "__main__":
    main()
