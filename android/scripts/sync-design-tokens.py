#!/usr/bin/env python3
"""Map shared Web semantic color roles into checked-in Android light/dark resources."""

import argparse
import importlib.util
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "turbo/packages/ui/src/styles/globals.css"
# Reuse the existing CSS color evaluator without invoking its Swift generator.
spec = importlib.util.spec_from_file_location(
    "okou_native_colors", ROOT / "ios/scripts/sync-design-tokens.py"
)
colors = importlib.util.module_from_spec(spec)
spec.loader.exec_module(colors)
ROLES = (
    "primary", "primary-foreground", "background", "foreground", "card", "card-foreground",
    "muted", "muted-foreground", "accent", "accent-foreground", "border",
    "destructive", "destructive-foreground",
)


def outputs():
    css = re.sub(r"/\*.*?\*/", "", SOURCE.read_text(), flags=re.S)
    light = colors.block(css, "  :root {")
    dark = light | colors.block(css, '  [data-theme="dark"] {')
    bindings = colors.block(css, "@theme {")
    result = {}
    for directory, variables in (("values", light), ("values-night", dark)):
        lines = [
            '<?xml version="1.0" encoding="utf-8"?>',
            '<!-- Generated from shared Web color roles. Run android/scripts/sync-design-tokens.py. -->',
            "<resources>",
        ]
        for role in ROLES:
            red, green, blue, alpha = colors.color_expression(bindings[f"color-{role}"], variables)
            value = "".join(f"{round(component * 255):02X}" for component in (alpha, red, green, blue))
            lines.append(f'    <color name="okou_{role.replace("-", "_")}">#{value}</color>')
        lines.append("</resources>")
        result[ROOT / f"android/app/src/main/res/{directory}/colors.generated.xml"] = "\n".join(lines) + "\n"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    stale = []
    for path, content in outputs().items():
        if not path.exists() or path.read_text() != content:
            stale.append(str(path.relative_to(ROOT)))
            if not args.check:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
    if args.check and stale:
        parser.exit(1, "Android colors are out of date:\n" + "\n".join(stale) + "\n")


if __name__ == "__main__":
    main()
