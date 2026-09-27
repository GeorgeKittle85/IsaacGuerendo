#!/usr/bin/env python3
"""Convert a Blender aircraft model (.blend) to a binary glTF for the browser.

Runs inside Blender's Python, either with Blender itself or with the `bpy`
module from PyPI (pip install bpy==4.2.*, Python 3.11):

    blender -b --python tools/build_gltf_model.py -- \
        --blend F-16_EXP_animated.blend --out site/data/aircraft/f16/model/f16.glb
    python3 tools/build_gltf_model.py --blend F-16_EXP_animated.blend \
        --out site/data/aircraft/f16/model/f16.glb

The model's armature actions are exported as separate glTF animations; the
web app drives them from the flight model's properties (gear position, control
surfaces, speed brake, canopy) instead of playing them.

Texture images the .blend points to are searched next to it and in
--textures.  Materials whose images cannot be found get a flat paint from
PAINT below (by material name), so the model still looks like an aircraft.
"""

import argparse
import os
import sys

import bpy

# Flat paint for materials without their textures: base colour (sRGB),
# metallic, roughness, alpha.  F-16s wear FS 36270 / 36375 greys.
PAINT = {
    "Body": ((0.56, 0.59, 0.62), 0.15, 0.55, 1.0),
    "Fuel Tank": ((0.56, 0.59, 0.62), 0.15, 0.55, 1.0),
    "Accessories": ((0.40, 0.42, 0.44), 0.3, 0.5, 1.0),
    "Cockpit": ((0.16, 0.17, 0.18), 0.1, 0.7, 1.0),
    "Gear": ((0.86, 0.86, 0.84), 0.2, 0.5, 1.0),
    "Wheel": ((0.09, 0.09, 0.09), 0.0, 0.9, 1.0),
    "Thruster": ((0.33, 0.30, 0.28), 0.8, 0.45, 1.0),
    "AIM 120 AMHRAAM": ((0.88, 0.88, 0.86), 0.1, 0.5, 1.0),
    "AIM 9 Sidewinder": ((0.82, 0.83, 0.82), 0.1, 0.5, 1.0),
    # The F-16's gold-tinted canopy.
    "Canopy": ((0.55, 0.47, 0.25), 0.6, 0.1, 0.35),
    "Window": ((0.55, 0.47, 0.25), 0.6, 0.1, 0.35),
}
DEFAULT_PAINT = ((0.6, 0.6, 0.6), 0.1, 0.6, 1.0)


def script_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--blend", required=True, help="the .blend file")
    ap.add_argument("--out", required=True, help="output .glb")
    ap.add_argument("--textures", help="directory holding the model's texture images")
    ap.add_argument("--max-texture", type=int, default=2048, help="downscale larger textures (px)")
    return ap.parse_args(argv)


def find_image(image, search_dirs):
    """The image's file on disk, or None."""
    if image.packed_file:
        return "packed"
    path = bpy.path.abspath(image.filepath)
    if os.path.isfile(path):
        return path
    name = os.path.basename(image.filepath.replace("\\", "/"))
    for d in search_dirs:
        for root, _dirs, files in os.walk(d):
            if name in files:
                return os.path.join(root, name)
    return None


def fix_materials(search_dirs, max_px):
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            continue
        nodes = mat.node_tree.nodes
        images = [n for n in nodes if n.type == "TEX_IMAGE" and n.image]
        missing = []
        for n in images:
            path = find_image(n.image, search_dirs)
            if path is None:
                missing.append(n.image.name)
            elif path != "packed":
                n.image.filepath = path
                n.image.reload()
                w, h = n.image.size
                if max(w, h) > max_px:
                    f = max_px / max(w, h)
                    n.image.scale(max(1, int(w * f)), max(1, int(h * f)))
        if not missing:
            print(f"material {mat.name}: {len(images)} textures")
            continue
        # Any missing image: replace the whole material with flat paint.
        rgb, metallic, rough, alpha = PAINT.get(mat.name, DEFAULT_PAINT)
        for n in list(nodes):
            nodes.remove(n)
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        out = nodes.new("ShaderNodeOutputMaterial")
        mat.node_tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
        lin = [c ** 2.2 for c in rgb]
        bsdf.inputs["Base Color"].default_value = (*lin, 1.0)
        bsdf.inputs["Metallic"].default_value = metallic
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Alpha"].default_value = alpha
        mat.blend_method = "BLEND" if alpha < 1 else "OPAQUE"
        print(f"material {mat.name}: textures missing ({', '.join(missing[:2])}...), flat paint")


def unparent_static_meshes():
    """Meshes parented to the armature that no bone deforms become top-level.

    Blender's glTF exporter misplaces such meshes (seat, HUD, nozzle...) under
    an armature whose parent has a non-uniform scale; at the top level, with
    their world transform, they export like the other static parts.
    """
    for ob in bpy.data.objects:
        if ob.type != "MESH" or not ob.parent or ob.parent.type != "ARMATURE":
            continue
        bones = {b.name for b in ob.parent.data.bones}
        if any(g.name in bones for g in ob.vertex_groups):
            continue
        world = ob.matrix_world.copy()
        ob.parent = None
        ob.matrix_world = world
        for m in [m for m in ob.modifiers if m.type == "ARMATURE"]:
            ob.modifiers.remove(m)
        print(f"static part {ob.name}: unparented from the armature")


def unique_bone_names():
    """Objects named like a bone are renamed: glTF loaders would rename the bone."""
    bones = {b.name for a in bpy.data.armatures for b in a.bones}
    for ob in bpy.data.objects:
        if ob.name in bones:
            old = ob.name
            ob.name = f"{old} mesh"
            print(f"object {old}: renamed to {ob.name} (a bone has its name)")


def main():
    args = script_args()
    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.blend))
    blend_dir = os.path.dirname(os.path.abspath(args.blend))
    search = [d for d in (args.textures, blend_dir) if d]
    fix_materials(search, args.max_texture)
    unparent_static_meshes()
    unique_bone_names()

    # Export at rest: the actions are exported on their own, not blended.
    for ob in bpy.data.objects:
        ad = ob.animation_data
        if ad:
            ad.action = None
            for t in ad.nla_tracks:
                t.mute = True
        if ob.type == "ARMATURE":
            for pb in ob.pose.bones:
                pb.location = (0, 0, 0)
                pb.rotation_quaternion = (1, 0, 0, 0)
                pb.rotation_euler = (0, 0, 0)
                pb.scale = (1, 1, 1)
    bpy.context.scene.frame_set(1)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(args.out),
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_skins=True,
        export_morph=False,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_optimize_animation_size=True,
        export_def_bones=False,
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_tangents=False,
        export_image_format="WEBP",
    )
    print(f"wrote {args.out}: {os.path.getsize(args.out) / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
    # The bpy module can crash while tearing Blender down; the work is done.
    sys.stdout.flush()
    os._exit(0)
