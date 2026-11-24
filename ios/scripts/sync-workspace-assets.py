#!/usr/bin/env python3
"""Bundle Web's deterministic Workspace default logos. --check is offline."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
SYSTEM = ROOT / "ios/Okou/DesignSystem/Components/Identity"
ASSETS = ROOT / "ios/Okou/Resources/Assets.xcassets"
SOURCES = ["turbo/packages/core/src/workspace-logo.ts", "turbo/packages/core/src/agent-avatar-texture.ts"]
MANIFEST = SYSTEM / "workspace-assets.json"
LOGO_VIEW = SYSTEM / "OkouWorkspaceLogo.swift"

def swift_letters():
    table = re.search(r"letterHexes: \[UInt32\] = \[(.*?)\]", LOGO_VIEW.read_text(), re.DOTALL)[1]
    return ["#" + value.upper() for value in re.findall(r"0x([0-9A-Fa-f]{6})", table)]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    texts = [(ROOT / path).read_text() for path in SOURCES]
    hashes = {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in SOURCES}
    if args.check:
        data = json.loads(MANIFEST.read_text())
        assert data["sources"] == hashes, "Workspace brand source changed; resync and review"
        for item in data["assets"]:
            svg = (ASSETS / (item["name"] + ".imageset") / "logo.svg").read_bytes()
            assert hashlib.sha256(svg).hexdigest() == item["sha256"], item["name"]
        letters = [item["letter"] for item in data["assets"]]
        assert swift_letters() == letters, "OkouWorkspaceLogo.letterHexes differs from workspace-logo.ts letters"
        print(f"Verified {len(data['assets'])} Workspace brand logos and initial colors.")
        return
    dark = re.search(r'TONAL_DARK_GROUND_BASE =\s*"([^"]+)"', texts[0])[1]
    light = re.search(r'AVATAR_TEXTURE_BASE =\s*"([^"]+)"', texts[1])[1]
    matches = re.findall(r'^    textureUrl: (.*),$', texts[0], re.MULTILINE)
    assert len(matches) == 8, "Review changed Web colorway schema"
    letters = re.findall(r'^    letter: "(#[0-9A-F]{6})",$', texts[0], re.MULTILINE)
    assert len(letters) == 8, "Review changed Web colorway letters"

    def bundle(entry):
        index, expression = entry
        texture = re.search(r'avatarTextureUrl\("([^"]+)"\)', expression)
        url = light + "/" + texture[1] + ".svg" if texture else expression.strip("`").replace("${TONAL_DARK_GROUND_BASE}", dark)
        raw = subprocess.run(["curl", "--http1.1", "-fsSL", "--max-time", "30", "--retry", "3", "--retry-all-errors", url], capture_output=True, check=True).stdout
        root = ET.fromstring(raw)
        viewbox = root.attrib["viewBox"]
        content = b"".join(ET.tostring(child) for child in root).decode()
        # Web paints the texture at 160%, centered.
        svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="328" height="328" viewBox="0 0 328 328"><defs><clipPath id="tile"><rect width="328" height="328"/></clipPath></defs><g clip-path="url(#tile)"><svg x="-98.4" y="-98.4" width="524.8" height="524.8" viewBox="{viewbox}">{content}</svg></g></svg>\n'
        name = f"WorkspaceDefault-{index}"
        directory = ASSETS / (name + ".imageset")
        directory.mkdir(exist_ok=True)
        (directory / "logo.svg").write_text(svg)
        (directory / "Contents.json").write_text(json.dumps({"images": [{"filename": "logo.svg", "idiom": "universal"}], "info": {"author": "xcode", "version": 1}, "properties": {"preserves-vector-representation": True}}, indent=2) + "\n")
        return {"name": name, "url": url, "sha256": hashlib.sha256(svg.encode()).hexdigest(), "letter": letters[index]}
    with ThreadPoolExecutor(max_workers=4) as pool:
        assets = list(pool.map(bundle, enumerate(matches)))
    MANIFEST.write_text(json.dumps({"sources": hashes, "assets": assets}, indent=2) + "\n")
    assert swift_letters() == letters, "Update OkouWorkspaceLogo.letterHexes to the workspace-logo.ts letters"
    print(f"Bundled {len(assets)} Web Workspace logos.")

if __name__ == "__main__":
    main()
