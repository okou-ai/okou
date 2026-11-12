#!/usr/bin/env python3
"""Generate the Okou avatar's artwork and texture from Web's OkouAvatar. --check is offline.

Web's `okou-avatar-artwork.ts` is the only copy of the drawing. This script turns it into
the Swift node tree `OkouAvatarArtwork` draws, and bundles the brand texture the default
agent sits on, at Web's 180% centred scale, as a vector asset. The rig's overlays, poses
and frame rules are ported by hand in `OkouAvatarArtwork.swift` and `OkouAvatarRig.swift`;
a change to any Web source fails `--check` so the port is reviewed with it.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
SYSTEM = ROOT / "ios/Okou/DesignSystem/Components/Identity"
ASSETS = ROOT / "ios/Okou/Resources/Assets.xcassets"
ARTWORK = "turbo/packages/ui/src/components/ui/okou-avatar-artwork.ts"
TEXTURES = "turbo/packages/core/src/agent-avatar-texture.ts"
SOURCES = [
    ARTWORK,
    "turbo/packages/ui/src/components/ui/okou-avatar-rig.ts",
    "turbo/packages/ui/src/components/ui/okou-avatar.tsx",
    TEXTURES,
]
OUTPUT = SYSTEM / "OkouAvatarArtwork.generated.swift"
MANIFEST = SYSTEM / "okou-avatar.json"
TEXTURE_ASSET = "OkouAvatarTexture"
# Web's `defaultAgentAvatarTextures()[0]`: the one tile that clears every colour the default
# agent is painted in. The texture source is hashed below, so a change there is reviewed here.
TEXTURE = "drop-lightblue-blue"
SVG = "{http://www.w3.org/2000/svg}"
NUMBER = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"


def artwork_svg(text):
    literal = re.search(r"OKOU_AVATAR_ARTWORK\s*=\s*'(.*)';", text, re.S)
    assert literal, "Review changed Web artwork module"
    return literal[1].replace("\\'", "'")


def number(value):
    text = f"{float(value):.6f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def matrix(transform):
    """An SVG transform list as one (a, b, c, d, e, f) matrix."""
    result = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    for name, args in re.findall(r"(\w+)\(([^)]*)\)", transform or ""):
        values = [float(v) for v in re.findall(NUMBER, args)]
        if name == "translate":
            step = (1, 0, 0, 1, values[0], values[1] if len(values) > 1 else 0)
        elif name == "scale":
            step = (values[0], 0, 0, values[1] if len(values) > 1 else values[0], 0, 0)
        elif name == "matrix":
            step = tuple(values)
        else:
            raise SystemExit(f"Unsupported artwork transform {name}")
        a, b, c, d, e, f = result
        a2, b2, c2, d2, e2, f2 = step
        result = (a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2,
                  a * e2 + c * f2 + e, b * e2 + d * f2 + f)
    return result


def color(element, key):
    """The colour a browser paints: the style's display-p3 value when it has one."""
    style = element.get("style", "")
    p3 = re.findall(key + r":color\(display-p3 (" + NUMBER + r") (" + NUMBER + r") (" + NUMBER + r")\)", style)
    if p3:
        return "p3({}, {}, {})".format(*(number(v) for v in p3[-1]))
    value = element.get(key)
    if value in (None, "none"):
        return None
    assert re.fullmatch(r"#[0-9A-Fa-f]{6}", value), f"Unsupported artwork colour {value}"
    return f"hex(0x{value[1:].upper()})"


def emit(element, clips, indent):
    tag = element.tag.removeprefix(SVG)
    pad = "  " * indent
    args = []
    if element.get("id"):
        args.append(f'"{element.get("id")}"')
    else:
        args.append("nil")
    if tag == "g":
        a, b, c, d, e, f = matrix(element.get("transform"))
        if (a, b, c, d, e, f) != (1, 0, 0, 1, 0, 0):
            args.append(f"transform: .init(a: {number(a)}, b: {number(b)}, c: {number(c)}, "
                        f"d: {number(d)}, tx: {number(e)}, ty: {number(f)})")
        if element.get("opacity"):
            args.append(f"opacity: {number(element.get('opacity'))}")
        clip = re.fullmatch(r"url\(#(.+)\)", element.get("clip-path", ""))
        if clip:
            args.append(f'clip: "{clips[clip[1]]}"')
        children = [child for child in element if child.tag.removeprefix(SVG) in ("g", "path", "circle", "ellipse")]
        lines = [f"{pad}group({', '.join(args)}, ["]
        lines += [emit(child, clips, indent + 1) + "," for child in children]
        lines.append(f"{pad}])")
        return "\n".join(lines)
    assert not element.get("transform"), "Artwork shapes carry no transform"
    if tag == "path":
        geometry = f'"{element.get("d")}"'
    elif tag == "circle":
        r = element.get("r")
        geometry = f'ellipse({number(element.get("cx"))}, {number(element.get("cy"))}, {number(r)}, {number(r)})'
    elif tag == "ellipse":
        geometry = (f'ellipse({number(element.get("cx"))}, {number(element.get("cy"))}, '
                    f'{number(element.get("rx"))}, {number(element.get("ry"))})')
    else:
        raise SystemExit(f"Unsupported artwork element {tag}")
    args.append(geometry)
    fill, stroke = color(element, "fill"), color(element, "stroke")
    if fill:
        args.append(f"fill: {fill}")
    if stroke:
        args.append(f"stroke: {stroke}")
        args.append(f"width: {number(element.get('stroke-width', '1'))}")
        if element.get("stroke-linecap", "butt") != "butt":
            args.append(f"cap: .{element.get('stroke-linecap')}")
        if element.get("stroke-linejoin", "miter") != "miter":
            args.append(f"join: .{element.get('stroke-linejoin')}")
    if element.get("opacity"):
        args.append(f"opacity: {number(element.get('opacity'))}")
    return f"{pad}shape({', '.join(args)})"


def generate_swift(svg_text):
    root = ET.fromstring(svg_text)
    assert root.get("viewBox") == "0 0 217 217", "Review changed artwork space"
    clips = {}
    for clip in root.iter(SVG + "clipPath"):
        rect = clip.find(SVG + "rect")
        width, height = number(rect.get("width")), number(rect.get("height"))
        clips[clip.get("id")] = f"M0 0H{width}V{height}H0Z"
    scene = root.find(SVG + "g")
    assert scene is not None and scene.get("id") == "scene", "Review changed artwork scene"
    lines = [
        "// Generated by ios/scripts/sync-okou-avatar.py. Do not edit by hand.",
        "// Source: " + ARTWORK,
        "import SwiftUI",
        "",
        "extension OkouAvatarArtwork {",
        "  /// Web's artwork as drawn, before the rig adds its overlays.",
        "  static func source() -> OkouAvatarNode {",
        emit(scene, clips, 2),
        "  }",
        "}",
        "",
    ]
    # Laid out by swift-format, so the generated file passes the same lint as the rest.
    return subprocess.run(["xcrun", "swift-format", "format", "--assume-filename", str(OUTPUT)],
                          input="\n".join(lines), capture_output=True, text=True, check=True).stdout


def bundle_texture(texts):
    assert f'"{TEXTURE}"' in texts[TEXTURES], "Review changed Web texture library"
    base = re.search(r'AVATAR_TEXTURE_BASE =\s*"([^"]+)"', texts[TEXTURES])[1]
    url = f"{base}/{TEXTURE}.svg"
    raw = subprocess.run(["curl", "--http1.1", "-fsSL", "--max-time", "30", "--retry", "3",
                          "--retry-all-errors", url], capture_output=True, check=True).stdout
    ET.register_namespace("", SVG[1:-1])
    tile = ET.fromstring(raw)
    content = "".join(ET.tostring(child, encoding="unicode") for child in tile)
    # Web draws the tile at 180% of the 40-unit frame, centred (offset -16, size 72).
    side, offset, size = 328, -16 / 40 * 328, 72 / 40 * 328
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{side}" height="{side}" viewBox="0 0 {side} {side}">'
           f'<defs><clipPath id="tile"><rect width="{side}" height="{side}"/></clipPath></defs>'
           f'<g clip-path="url(#tile)"><svg x="{number(offset)}" y="{number(offset)}" width="{number(size)}" '
           f'height="{number(size)}" viewBox="{tile.get("viewBox")}" preserveAspectRatio="xMidYMid slice">'
           f"{content}</svg></g></svg>\n")
    directory = ASSETS / (TEXTURE_ASSET + ".imageset")
    directory.mkdir(exist_ok=True)
    (directory / "texture.svg").write_text(svg)
    contents = {"images": [{"filename": "texture.svg", "idiom": "universal"}],
                "info": {"author": "xcode", "version": 1},
                "properties": {"preserves-vector-representation": True}}
    (directory / "Contents.json").write_text(json.dumps(contents, indent=2) + "\n")
    return {"name": TEXTURE_ASSET, "url": url, "sha256": hashlib.sha256(svg.encode()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    texts = {path: (ROOT / path).read_text() for path in SOURCES}
    hashes = {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in SOURCES}
    swift = generate_swift(artwork_svg(texts[ARTWORK]))
    if args.check:
        data = json.loads(MANIFEST.read_text())
        assert data["sources"] == hashes, "Web OkouAvatar source changed; resync and review the port"
        assert OUTPUT.read_text() == swift, f"{OUTPUT.name} is stale; run sync-okou-avatar.py"
        texture = (ASSETS / (TEXTURE_ASSET + ".imageset") / "texture.svg").read_bytes()
        assert hashlib.sha256(texture).hexdigest() == data["texture"]["sha256"], TEXTURE_ASSET
        print("Verified the Okou avatar artwork and its texture.")
        return
    OUTPUT.write_text(swift)
    texture = bundle_texture(texts)
    MANIFEST.write_text(json.dumps({"sources": hashes, "texture": texture}, indent=2) + "\n")
    print(f"Generated {OUTPUT.name} and bundled {TEXTURE_ASSET} ({TEXTURE}).")


if __name__ == "__main__":
    main()
