/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { COLOR_THEMES } from "@okouai/api-contracts/contracts/user-preferences";
import { describe, expect, it } from "vitest";

// Palette tokens only exist in the shell's stylesheet. The test DOM never
// compiles or applies it, so the declarations are read from the source.
function readEntrypointCss(): string {
  const candidates = [
    join(process.cwd(), "src/views/css/index.css"),
    join(process.cwd(), "apps/platform/src/views/css/index.css"),
  ];
  const path = candidates.find((candidate) => {
    return existsSync(candidate);
  });
  if (path === undefined) {
    throw new Error("Unable to locate the App entrypoint CSS");
  }
  return readFileSync(path, "utf8");
}

const entrypointCss = readEntrypointCss();

function readPaletteDeclarations(colorTheme: string): Map<string, string> {
  const selector = `[data-color-theme="${colorTheme}"] {`;
  const start = entrypointCss.indexOf(selector);
  if (start === -1) {
    throw new Error(`Unable to locate the ${colorTheme} palette`);
  }
  const body = entrypointCss.slice(
    start + selector.length,
    entrypointCss.indexOf("}", start),
  );
  const declarations = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/gu)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) {
      declarations.set(name, value.trim());
    }
  }
  return declarations;
}

function resolveTriplet(
  declarations: Map<string, string>,
  name: string,
): string {
  const value = declarations.get(name);
  if (value === undefined) {
    throw new Error(`Missing ${name}`);
  }
  const reference = /^var\((--[\w-]+)\)$/u.exec(value)?.[1];
  return reference === undefined
    ? value
    : resolveTriplet(declarations, reference);
}

type Rgb = readonly [number, number, number];

function hslTripletToRgb(triplet: string): Rgb {
  const match = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/u.exec(triplet);
  if (!match) {
    throw new Error(`Not an HSL triplet: ${triplet}`);
  }
  const hue = Number(match[1]);
  const saturation = Number(match[2]) / 100;
  const lightness = Number(match[3]) / 100;
  const amplitude = saturation * Math.min(lightness, 1 - lightness);
  const channel = (offset: number): number => {
    const k = (offset + hue / 30) % 12;
    return lightness - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

// APCA 0.0.98G-4g lightness contrast, as a magnitude.
function apcaContrast(text: Rgb, background: Rgb): number {
  const luminance = ([r, g, b]: Rgb): number => {
    const y = 0.2126729 * r ** 2.4 + 0.7151522 * g ** 2.4 + 0.072175 * b ** 2.4;
    return y > 0.022 ? y : y + (0.022 - y) ** 1.414;
  };
  const textY = luminance(text);
  const backgroundY = luminance(background);
  const contrast =
    backgroundY > textY
      ? (backgroundY ** 0.56 - textY ** 0.57) * 1.14
      : (backgroundY ** 0.65 - textY ** 0.62) * 1.14;
  return Math.abs(contrast) < 0.1 ? 0 : (Math.abs(contrast) - 0.027) * 100;
}

const WHITE = "0 0% 100%";
const INK = "40 4.3% 13.5%";
const PRESETS = COLOR_THEMES.filter((colorTheme) => {
  return colorTheme !== "default";
});

describe("color theme palettes", () => {
  // A filled primary takes whichever of white and Ink reads better on that
  // fill. Amber's dark label is a property of Amber, not a rule for every
  // palette: a mid-tone red carried pure black at Lc 39.
  it.each(PRESETS)(
    "labels %s's fills with the stronger of white and Ink",
    (colorTheme) => {
      const declarations = readPaletteDeclarations(colorTheme);
      for (const [fill, label] of [
        ["--okou-color-theme-primary", "--okou-color-theme-primary-foreground"],
        [
          "--okou-color-theme-primary-dark",
          "--okou-color-theme-primary-dark-foreground",
        ],
      ] as const) {
        const fillRgb = hslTripletToRgb(resolveTriplet(declarations, fill));
        const labelTriplet = resolveTriplet(declarations, label);
        expect([WHITE, INK]).toContain(labelTriplet);

        const chosen = apcaContrast(hslTripletToRgb(labelTriplet), fillRgb);
        const other = apcaContrast(
          hslTripletToRgb(labelTriplet === WHITE ? INK : WHITE),
          fillRgb,
        );
        expect(chosen).toBeGreaterThanOrEqual(60);
        expect(chosen).toBeGreaterThan(other);
      }
    },
  );

  it.each(PRESETS)(
    "gives %s an ambient strength in both themes",
    (colorTheme) => {
      const declarations = readPaletteDeclarations(colorTheme);
      for (const name of [
        "--okou-color-theme-ambient-anchor",
        "--okou-color-theme-ambient-companion",
        "--okou-color-theme-ambient-anchor-dark",
        "--okou-color-theme-ambient-companion-dark",
      ]) {
        expect(declarations.get(name)).toMatch(/^\d+(\.\d+)?%$/u);
      }
    },
  );
});
