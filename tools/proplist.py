"""Minimal reader for FlightGear PropertyList XML files.

Implements the parts of SimGear's readProperties() the web build needs:
`include=` merging (the included file first, then the including element's own
children override it), `n=` indices with per-parent counters, `type=`, and
`alias=`.  Include paths are resolved relative to the including file, then
the aircraft directory, then FG_ROOT, like FlightGear does.
"""

import os
import xml.etree.ElementTree as ET


class PropNode:
    __slots__ = ("name", "index", "children", "value", "type", "alias")

    def __init__(self, name="", index=0):
        self.name = name
        self.index = index
        self.children = {}  # (name, index) -> PropNode, insertion ordered
        self.value = None
        self.type = None
        self.alias = None

    def child(self, name, index, create=True):
        key = (name, index)
        node = self.children.get(key)
        if node is None and create:
            node = PropNode(name, index)
            self.children[key] = node
        return node

    def get(self, path):
        node = self
        for part in [p for p in path.strip("/").split("/") if p]:
            name, index = part, 0
            if part.endswith("]") and "[" in part:
                name, idx = part[:-1].split("[")
                index = int(idx)
            node = node.child(name, index, create=False)
            if node is None:
                return None
        return node

    def walk(self, prefix=""):
        for (name, index), node in self.children.items():
            path = f"{prefix}/{name}" + (f"[{index}]" if index else "")
            yield path, node
            yield from node.walk(path)


class PropertyListReader:
    def __init__(self, fg_root, search_dirs=()):
        self.fg_root = fg_root
        self.search_dirs = list(search_dirs)
        self.missing = []  # includes that could not be resolved

    def resolve(self, ref, base_dir):
        dirs = [self.fg_root] if ref.startswith("/") else [base_dir, *self.search_dirs, self.fg_root]
        for d in dirs:
            p = os.path.normpath(os.path.join(d, ref.lstrip("/")))
            if os.path.isfile(p):
                return p
        return None

    def read(self, path, node=None):
        node = node or PropNode()
        root = ET.parse(path).getroot()
        self._merge(root, node, os.path.dirname(path))
        return node

    def _merge(self, el, node, base_dir):
        inc = el.get("include")
        if inc:
            inc_path = self.resolve(inc, base_dir)
            if inc_path:
                inc_root = ET.parse(inc_path).getroot()
                self._merge(inc_root, node, os.path.dirname(inc_path))
            else:
                self.missing.append(inc)

        counters = {}
        has_children = False
        for child in el:
            if not isinstance(child.tag, str):
                continue  # comments / processing instructions
            has_children = True
            name = child.tag
            n = child.get("n")
            if n is not None:
                index = int(n)
                counters[name] = max(counters.get(name, 0), index + 1)
            else:
                index = counters.get(name, 0)
                counters[name] = index + 1
            self._merge(child, node.child(name, index), base_dir)

        if el.get("alias"):
            node.alias = el.get("alias")
        elif not has_children and node.name:
            text = el.text or ""
            node.type = el.get("type", node.type or "unspecified")
            node.value = text if node.type == "string" else text.strip()


def typed_value(node):
    """Converts a leaf to a JSON-friendly value, or None if not a value leaf."""
    if node.value is None:
        return None
    t = node.type or "unspecified"
    v = node.value
    try:
        if t == "bool":
            return v.lower() in ("true", "1", "yes")
        if t in ("int", "long"):
            return int(float(v))
        if t in ("double", "float"):
            return float(v)
        if t == "string":
            return v
        # unspecified: numbers become numbers, everything else stays text
        try:
            return int(v) if v.lstrip("-").isdigit() else float(v)
        except ValueError:
            if v.lower() in ("true", "false"):
                return v.lower() == "true"
            return v
    except ValueError:
        return v


def to_json(node):
    """Serialises a PropNode tree, keeping child order (FlightGear evaluates
    property-rule components and model animations in document order).

    Each node is {"n": name, "i": index, "v": text, "t": type, "a": alias,
    "c": [children]} with empty fields omitted.
    """
    out = {"n": node.name}
    if node.index:
        out["i"] = node.index
    if node.alias:
        out["a"] = node.alias
    if node.value is not None and not node.children:
        out["v"] = node.value
        if node.type and node.type != "unspecified":
            out["t"] = node.type
    if node.children:
        out["c"] = [to_json(ch) for ch in node.children.values()]
    return out
