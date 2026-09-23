"""Reader for FlightGear's BTG (binary terrain geometry) scenery format.

Follows SimGear's simgear/io/sg_binobj.cxx: a gzip'd little-endian stream
with a bounding sphere (tile centre in ECEF metres), float vertex offsets from
that centre, byte-packed normals, float texture coordinates, and indexed
point/triangle/strip/fan groups each tagged with a material name.
"""

import gzip
import struct
from dataclasses import dataclass, field

SG_BOUNDING_SPHERE = 0
SG_VERTEX_LIST = 1
SG_NORMAL_LIST = 2
SG_TEXCOORD_LIST = 3
SG_COLOR_LIST = 4
SG_VA_FLOAT_LIST = 5
SG_VA_INTEGER_LIST = 6
SG_POINTS = 9
SG_TRIANGLE_FACES = 10
SG_TRIANGLE_STRIPS = 11
SG_TRIANGLE_FANS = 12

SG_IDX_VERTICES = 0x01
SG_IDX_NORMALS = 0x02
SG_IDX_COLORS = 0x04
SG_IDX_TEXCOORDS_0 = 0x08
SG_IDX_TEXCOORDS_1 = 0x10
SG_IDX_TEXCOORDS_2 = 0x20
SG_IDX_TEXCOORDS_3 = 0x40


@dataclass
class Group:
    kind: int            # SG_POINTS / SG_TRIANGLE_FACES / STRIPS / FANS
    material: str
    v: list              # vertex indices
    n: list = field(default_factory=list)
    tc: list = field(default_factory=list)  # texcoord indices (unit 0)


@dataclass
class BTG:
    version: int
    center: tuple        # ECEF metres (gbs_center)
    radius: float
    vertices: list       # (x, y, z) float offsets from centre
    normals: list        # unit vectors (ECEF)
    texcoords: list      # (u, v)
    groups: list


def _bits(mask):
    return bin(mask & 0xFF).count("1")


def read_btg(path):
    with gzip.open(path, "rb") if path.endswith(".gz") else open(path, "rb") as fh:
        data = fh.read()
    return parse_btg(data)


def parse_btg(data):
    off = 0

    def u32():
        nonlocal off
        v = struct.unpack_from("<I", data, off)[0]
        off += 4
        return v

    def u16():
        nonlocal off
        v = struct.unpack_from("<H", data, off)[0]
        off += 2
        return v

    def s16():
        nonlocal off
        v = struct.unpack_from("<h", data, off)[0]
        off += 2
        return v

    def u8():
        nonlocal off
        v = data[off]
        off += 1
        return v

    def raw(n):
        nonlocal off
        b = data[off:off + n]
        off += n
        return b

    header = u32()
    if ((header >> 24) & 0xFF) != ord("S") or ((header >> 16) & 0xFF) != ord("G"):
        raise ValueError("bad BTG magic")
    version = header & 0xFFFF
    u32()  # creation time
    if version >= 10:
        nobjects = u32()
    elif version >= 7:
        nobjects = u16()
    else:
        nobjects = s16()

    center = (0.0, 0.0, 0.0)
    radius = 0.0
    vertices, normals, texcoords, groups = [], [], [], []

    def read_counts():
        if version >= 10:
            return u32(), u32()
        if version >= 7:
            return u16(), u16()
        return s16(), s16()

    def read_properties(n):
        props = []
        for _ in range(n):
            ptype = u8()
            nbytes = u32()
            props.append((ptype, raw(nbytes)))
        return props

    for _ in range(nobjects):
        obj_type = u8()
        nprops, nelems = read_counts()
        if obj_type in (SG_POINTS, SG_TRIANGLE_FACES, SG_TRIANGLE_STRIPS, SG_TRIANGLE_FANS):
            material = ""
            idx_mask = SG_IDX_VERTICES if obj_type == SG_POINTS else (SG_IDX_VERTICES | SG_IDX_TEXCOORDS_0)
            va_mask = 0
            for ptype, pdata in read_properties(nprops):
                if ptype == 0:  # SG_MATERIAL
                    material = pdata.split(b"\0")[0].decode("latin-1")
                elif ptype == 1:  # SG_INDEX_TYPES
                    idx_mask = pdata[0] if len(pdata) == 1 else idx_mask
                elif ptype == 2 and len(pdata) == 4:  # SG_VERT_ATTRIBS
                    va_mask = struct.unpack("<I", pdata)[0]
            isz = 4 if version >= 10 else 2
            fmt = "<I" if version >= 10 else "<H"
            stride = _bits(idx_mask) + bin(va_mask).count("1")
            for _ in range(nelems):
                nbytes = u32()
                chunk = raw(nbytes)
                count = nbytes // (isz * stride)
                vals = struct.unpack_from("<%d%s" % (count * stride, fmt[1]), chunk, 0)
                vs, ns, tcs = [], [], []
                pos = 0
                for _i in range(count):
                    if idx_mask & SG_IDX_VERTICES:
                        vs.append(vals[pos]); pos += 1
                    if idx_mask & SG_IDX_NORMALS:
                        ns.append(vals[pos]); pos += 1
                    if idx_mask & SG_IDX_COLORS:
                        pos += 1
                    if idx_mask & SG_IDX_TEXCOORDS_0:
                        tcs.append(vals[pos]); pos += 1
                    for bit in (SG_IDX_TEXCOORDS_1, SG_IDX_TEXCOORDS_2, SG_IDX_TEXCOORDS_3):
                        if idx_mask & bit:
                            pos += 1
                    pos += bin(va_mask).count("1")
                # SimGear drops zero-area single triangles (WS2.0 fix)
                if count == 3 and obj_type != SG_POINTS and (vs[0] == vs[1] or vs[1] == vs[2] or vs[0] == vs[2]):
                    continue
                if vs:
                    groups.append(Group(obj_type, material, vs, ns, tcs))
        else:
            read_properties(nprops)
            for _ in range(nelems):
                nbytes = u32()
                chunk = raw(nbytes)
                if obj_type == SG_BOUNDING_SPHERE:
                    cx, cy, cz, r = struct.unpack_from("<dddf", chunk, 0)
                    center, radius = (cx, cy, cz), r
                elif obj_type == SG_VERTEX_LIST:
                    n = nbytes // 12
                    vals = struct.unpack_from("<%df" % (n * 3), chunk, 0)
                    vertices.extend(zip(vals[0::3], vals[1::3], vals[2::3]))
                elif obj_type == SG_NORMAL_LIST:
                    n = nbytes // 3
                    for i in range(n):
                        x, y, z = (chunk[3 * i] / 127.5 - 1.0, chunk[3 * i + 1] / 127.5 - 1.0,
                                   chunk[3 * i + 2] / 127.5 - 1.0)
                        l = (x * x + y * y + z * z) ** 0.5 or 1.0
                        normals.append((x / l, y / l, z / l))
                elif obj_type == SG_TEXCOORD_LIST:
                    n = nbytes // 8
                    vals = struct.unpack_from("<%df" % (n * 2), chunk, 0)
                    texcoords.extend(zip(vals[0::2], vals[1::2]))
                # colour and vertex-attribute lists are not needed here
    return BTG(version, center, radius, vertices, normals, texcoords, groups)


def triangles(group):
    """Yields (i0, i1, i2) positions into the group's index lists."""
    n = len(group.v)
    if group.kind == SG_TRIANGLE_FACES:
        for i in range(2, n, 3):
            yield i - 2, i - 1, i
    elif group.kind == SG_TRIANGLE_STRIPS:
        for i in range(2, n):
            yield (i - 1, i - 2, i) if i % 2 else (i - 2, i - 1, i)
    elif group.kind == SG_TRIANGLE_FANS:
        for i in range(2, n):
            yield 0, i - 1, i
