#!/usr/bin/env python3
"""Map shared Web semantic color roles into checked-in Android light/dark resources."""

import argparse
import importlib.util
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "turbo/packages/ui/src/styles/globals.css"
PALETTE_SOURCE = ROOT / "turbo/apps/platform/src/views/css/index.css"
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
    "selection",
)
SWATCH_COMPANION = "swatch-companion"


def expand(expression, variables, seen=()):
    """Resolve the scalar CSS custom properties used by the native semantic roles."""
    pattern = r"var\(\s*--([\w-]+)(?:\s*,\s*([^()]*))?\s*\)"

    def replace(match):
        name, fallback = match.groups()
        if name in seen:
            raise ValueError(f"Cyclic palette variable: {name}")
        if name in variables:
            return expand(variables[name], variables, (*seen, name))
        if fallback is not None:
            return expand(fallback, variables, seen)
        raise ValueError(f"Missing palette variable: {name}")

    while "var(" in expression:
        expanded = re.sub(pattern, replace, expression)
        if expanded == expression:
            raise ValueError(f"Unsupported palette expression: {expression}")
        expression = expanded
    return expression


def android_color(expression, variables):
    expression = expression.strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", expression):
        return "#FF" + expression[1:].upper()
    red, green, blue, alpha = colors.color_expression(expression, variables)
    return "#" + "".join(f"{round(component * 255):02X}" for component in (alpha, red, green, blue))


def relative_luminance(argb):
    def linear(channel):
        return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4

    red, green, blue = (linear(int(argb[i : i + 2], 16) / 255) for i in (3, 5, 7))
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def android_primary_foreground(primary, foreground):
    # Android uses the same foreground for small text and for icons on primary fills.
    # Web chooses labels by APCA. Check the emitted Android colors against WCAG 2.
    fill = relative_luminance(primary) + 0.05
    text = relative_luminance(foreground) + 0.05
    if max(fill, text) / min(fill, text) >= 4.5:
        return foreground
    return "#FF000000" if fill / 0.05 >= 1.05 / fill else "#FFFFFFFF"


def outputs():
    css = re.sub(r"/\*.*?\*/", "", SOURCE.read_text(), flags=re.S)
    light = colors.block(css, "  :root {")
    dark = light | colors.block(css, '  [data-theme="dark"] {')
    bindings = colors.block(css, "@theme {")
    bindings["color-selection"] = "hsl(var(--selection))"
    palettes = re.sub(r"/\*.*?\*/", "", PALETTE_SOURCE.read_text(), flags=re.S)
    preferences = (ROOT / "turbo/packages/api-contracts/src/validators/user-preferences.ts").read_text()
    names = re.findall(r'"([a-z-]+)"', re.search(r"COLOR_THEMES = \[(.*?)\] as const", preferences, re.S)[1])
    common_light = colors.block(palettes, ':root[data-gradient-color-themes][data-color-theme] {')
    dark_selector = re.search(r':root:is\(\s*\.dark,\s*\[data-theme="dark"\]\s*\)\[data-gradient-color-themes\]\[data-color-theme\]\s*\{', palettes)
    common_dark = colors.block(palettes, dark_selector[0])
    result = {}
    for directory, base in (("values", light), ("values-night", dark)):
        lines = [
            '<?xml version="1.0" encoding="utf-8"?>',
            '<!-- Generated from shared Web color roles. Run android/scripts/sync-design-tokens.py. -->',
            "<resources>",
        ]
        for name in names:
            variables = base | colors.block(palettes, f'[data-color-theme="{name}"] {{')
            if name != "default":
                variables |= common_light
                if directory == "values-night":
                    variables |= common_dark
            resolved = variables | {role: expand(variables[role], variables, (role,)) for role in ROLES}
            prefix = "okou_" + (name.replace("-", "_") + "_" if name != "default" else "")
            expressions = {role: bindings[f"color-{role}"] for role in ROLES}
            expressions[SWATCH_COMPANION] = variables["okou-color-theme-companion"]
            values = {
                role: android_color(expression, resolved)
                for role, expression in expressions.items()
            }
            values["primary-foreground"] = android_primary_foreground(
                values["primary"], values["primary-foreground"]
            )
            for role, value in values.items():
                lines.append(f'    <color name="{prefix}{role.replace("-", "_")}">{value}</color>')
            lines.append(f'    <style name="OkouPalette_{name.replace("-", "_")}">')
            for role in values:
                key = role.replace("-", "_")
                lines.append(f'        <item name="okou_palette_{key}">@color/{prefix}{key}</item>')
            lines.append('    </style>')
        lines.append("</resources>")
        result[ROOT / f"android/app/src/main/res/{directory}/colors.generated.xml"] = "\n".join(lines) + "\n"
    attributes = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Generated by android/scripts/sync-design-tokens.py. -->', '<resources>']
    attributes += [f'    <attr name="okou_palette_{role.replace("-", "_")}" format="color" />' for role in (*ROLES, SWATCH_COMPANION)]
    attributes.append('</resources>')
    result[ROOT / "android/app/src/main/res/values/palette-attrs.generated.xml"] = "\n".join(attributes) + "\n"
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
