"""desiview — a 3D map of the DESI DR1 QSO source distribution.

Sky position places a source on a sphere, redshift places it along the
radius, and colour is imaging footprint.

    from desiview import view
    view()
"""
from .prepare import prepare
from .viewer import view

__version__ = "0.1.0"
__all__ = ["view", "prepare", "__version__"]
