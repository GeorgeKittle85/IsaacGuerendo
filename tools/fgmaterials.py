"""FlightGear material library (simgear/scene/material/matlib.cxx) in Python.

Reads Materials/regions/materials.xml with its region includes and resolves
each material name for a location the way SGMaterialLib::find() does: the
last-loaded definition whose region contains the point (and whose condition,
e.g. the season, holds) wins.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from proplist import PropertyListReader  # noqa: E402


def _num(node, name, default):
    c = node.get(name)
    if c is None or c.value in (None, ""):
        return default
    try:
        return float(c.value)
    except ValueError:
        return default


def _bool(node, name, default):
    c = node.get(name)
    if c is None or c.value in (None, ""):
        return default
    return c.value.strip().lower() in ("1", "true", "yes")


def _color(node, name, default):
    c = node.get(name)
    if c is None:
        return default
    return [_num(c, k, d) for k, d in zip("rgba", default)]


def _condition_ok(cond, season):
    """Evaluates the simple conditions materials use (season checks)."""
    if cond is None:
        return True

    def ev(n):
        name = n.name
        kids = list(n.children.values())
        if name in ("condition", "and"):
            return all(ev(k) for k in kids)
        if name == "or":
            return any(ev(k) for k in kids)
        if name == "not":
            return not ev(kids[0]) if kids else True
        if name in ("equals", "not-equals"):
            prop = n.get("property")
            val = n.get("value")
            if prop is not None and val is not None and "season" in (prop.value or ""):
                eq = (val.value or "").strip() == season
                return eq if name == "equals" else not eq
            return True
        return True

    return ev(cond)


class Material:
    def __init__(self, node, areas, cond_ok):
        self.node = node
        self.areas = areas
        self.cond_ok = cond_ok
        self.names = [c.value.strip() for (k, _i), c in node.children.items() if k == "name" and c.value]

    def valid(self, lon, lat):
        if not self.cond_ok:
            return False
        if not self.areas:
            return True
        return any(x0 <= lon <= x1 and y0 <= lat <= y1 for x0, x1, y0, y1 in self.areas)

    def textures(self):
        """Base texture of each <texture-set> (or plain <texture>)."""
        out = []
        for (k, _i), c in self.node.children.items():
            if k == "texture" and c.value:
                out.append(c.value.strip())
            elif k == "texture-set":
                t = c.get("texture")
                if t is not None and t.value:
                    out.append(t.value.strip())
        return out

    def describe(self):
        n = self.node
        effect = (n.get("effect").value.strip() if n.get("effect") is not None and n.get("effect").value else "Effects/terrain-default")
        return {
            "effect": effect,
            "textures": self.textures(),
            "xsize": _num(n, "xsize", 0.0),
            "ysize": _num(n, "ysize", 0.0),
            "ambient": _color(n, "ambient", [0.2, 0.2, 0.2, 1.0]),
            "diffuse": _color(n, "diffuse", [0.8, 0.8, 0.8, 1.0]),
            "specular": _color(n, "specular", [0.0, 0.0, 0.0, 1.0]),
            "emissive": _color(n, "emissive", [0.0, 0.0, 0.0, 1.0]),
            "shininess": _num(n, "shininess", 1.0),
            "solid": _bool(n, "solid", True),
            "frictionFactor": _num(n, "friction-factor", 1.0),
            "rollingFriction": _num(n, "rolling-friction", 0.02),
            "bumpiness": _num(n, "bumpiness", 0.0),
            "loadResistance": _num(n, "load-resistance", 1e30),
            "lightCoverage": _num(n, "light-coverage", 0.0),
        }


class MaterialLib:
    def __init__(self, fg_root, materials_file="Materials/regions/materials.xml", season="summer"):
        reader = PropertyListReader(fg_root)
        root = reader.read(os.path.join(fg_root, materials_file))
        self.by_name = {}
        for (k, _i), region in root.children.items():
            if k != "region":
                continue
            areas = []
            for (ak, _ai), a in region.children.items():
                if ak != "area":
                    continue
                x1, x2 = _num(a, "lon1", -180), _num(a, "lon2", 180)
                y1, y2 = _num(a, "lat1", -90), _num(a, "lat2", 90)
                areas.append((min(x1, x2), max(x1, x2), min(y1, y2), max(y1, y2)))
            cond_ok = _condition_ok(region.get("condition"), season)
            for (mk, _mi), m in region.children.items():
                if mk != "material":
                    continue
                mat = Material(m, areas, cond_ok)
                for name in mat.names:
                    self.by_name.setdefault(name, []).append(mat)

    def find(self, name, lon, lat):
        for mat in reversed(self.by_name.get(name, [])):
            if mat.valid(lon, lat):
                return mat
        return None
