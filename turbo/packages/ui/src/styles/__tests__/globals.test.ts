/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function readGlobalCss(): string {
  const candidates = [
    join(process.cwd(), "src/styles/globals.css"),
    join(process.cwd(), "packages/ui/src/styles/globals.css"),
  ];
  const path = candidates.find((candidate) => {
    return existsSync(candidate);
  });
  if (path === undefined) {
    throw new Error("Unable to locate UI global CSS");
  }
  return readFileSync(path, "utf8");
}

const globalCss = readGlobalCss();

/** Returns the declaration body of the first rule introduced by `selector`. */
function readRuleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) {
    throw new Error(`Unable to locate CSS rule for ${selector}`);
  }
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") {
      depth += 1;
      continue;
    }
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return css.slice(open + 1, index);
      }
    }
  }
  throw new Error(`Unterminated CSS rule for ${selector}`);
}

/** Maps each `--state-<step>-alpha` declaration in `themeBody` to its percent. */
function readAlphas(themeBody: string): Map<string, number> {
  const alphas = new Map<string, number>();
  for (const [, step, percent] of themeBody.matchAll(
    /--state-([a-z-]+)-alpha:\s*([\d.]+)%/g,
  )) {
    if (step !== undefined && percent !== undefined) {
      alphas.set(step, Number(percent));
    }
  }
  return alphas;
}

function readAlpha(themeBody: string, name: string): number {
  const alpha = readAlphas(themeBody).get(name);
  if (alpha === undefined) {
    throw new Error(`Missing --state-${name}-alpha`);
  }
  return alpha;
}

type Rgb = readonly [number, number, number];

function readCustomProperties(themeBody: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const [, name, value] of themeBody.matchAll(
    /(--[a-z0-9-]+):\s*([^;]+);/g,
  )) {
    if (name !== undefined && value !== undefined) {
      properties.set(name, value.replace(/\s+/g, " ").trim());
    }
  }
  return properties;
}

function resolveCustomProperty(
  properties: ReadonlyMap<string, string>,
  name: string,
): string {
  const seen = new Set<string>();
  let current = name;
  while (true) {
    if (seen.has(current)) {
      throw new Error(`Circular custom property reference at ${current}`);
    }
    seen.add(current);
    const value = properties.get(current);
    if (value === undefined) {
      throw new Error(`Missing custom property ${current}`);
    }
    const reference = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(value)?.[1];
    if (reference === undefined) {
      return value;
    }
    current = reference;
  }
}

function hslToRgb(value: string): Rgb {
  const channels = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(value);
  if (channels === null) {
    throw new Error(`Unable to parse HSL channels from ${value}`);
  }
  const hue = Number(channels[1]);
  const saturation = Number(channels[2]) / 100;
  const lightness = Number(channels[3]) / 100;
  const amplitude = saturation * Math.min(lightness, 1 - lightness);
  const channel = (turn: number): number => {
    const section = (turn + hue / 30) % 12;
    return (
      255 *
      (lightness -
        amplitude *
          Math.max(-1, Math.min(section - 3, Math.min(9 - section, 1))))
    );
  };
  return [channel(0), channel(8), channel(4)];
}

function color(properties: ReadonlyMap<string, string>, name: string): Rgb {
  return hslToRgb(resolveCustomProperty(properties, name));
}

function composite(background: Rgb, foreground: Rgb, alpha: number): Rgb {
  return [
    Math.round(foreground[0] * alpha + background[0] * (1 - alpha)),
    Math.round(foreground[1] * alpha + background[1] * (1 - alpha)),
    Math.round(foreground[2] * alpha + background[2] * (1 - alpha)),
  ];
}

function relativeLuminance(rgb: Rgb): number {
  const linearize = (channel: number): number => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * linearize(rgb[0]) +
    0.7152 * linearize(rgb[1]) +
    0.0722 * linearize(rgb[2])
  );
}

function contrastRatio(foreground: Rgb, background: Rgb): number {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((channel) => {
      return Math.round(channel).toString(16).padStart(2, "0");
    })
    .join("")}`.toUpperCase();
}

/** Returns the value of the first `--<name>:` declaration, without its `;`. */
function readDeclarationValue(css: string, name: string): string {
  const start = css.indexOf(`--${name}:`);
  if (start === -1) {
    throw new Error(`Unable to locate --${name}`);
  }
  return css.slice(start + `--${name}:`.length, css.indexOf(";", start));
}

const THEMES = [
  { name: "light", selector: ":root" },
  { name: "dark", selector: '[data-theme="dark"]' },
];

describe("global focus colors", () => {
  it("sets native outlines to the semantic focus color before focus", () => {
    expect(globalCss).toMatch(
      /\*\s*{[\s\S]*?outline-color:\s*hsl\(var\(--ring\)\);[\s\S]*?}/,
    );
  });

  it.each(THEMES)(
    "resolves $name's focus color from the primary scale",
    ({ selector }) => {
      const theme = readRuleBody(globalCss, selector);
      const ring = /--ring:\s*var\(--(primary-\d+)\);/.exec(theme);

      expect(ring).not.toBeNull();
      // The stop each theme reaches for is a design choice and moves with the
      // palette; what must hold is that it is a stop, not a loose literal.
      const declaration = theme
        .split("\n")
        .find((line) => {
          return line.trimStart().startsWith(`--${ring?.[1] ?? ""}:`);
        })
        ?.trim();

      expect(declaration).toMatch(/^--primary-\d+:\s*[\d.]+ [\d.]+% [\d.]+%;/);
    },
  );
});

describe("stroke weights", () => {
  function readThemeNumber(name: string): number {
    const match = new RegExp(`--${name}:\\s*([\\d.]+)(px)?;`).exec(globalCss);
    if (match === null) {
      throw new Error(`Unable to locate --${name}`);
    }
    return Number(match[1]);
  }

  it("draws an emphasized edge and an icon at one weight", () => {
    // The two are the same decision in different units: a border width carries
    // px, while the icon token resolves in SVG user space and is unitless.
    // Retuning either alone would silently split the weight in two.
    expect(readThemeNumber("border-width-emphasis")).toBe(
      readThemeNumber("stroke-width-icon"),
    );
  });

  it("keeps the hairline the lighter of the two", () => {
    expect(readThemeNumber("default-border-width")).toBeLessThan(
      readThemeNumber("border-width-emphasis"),
    );
  });
});

describe("global Lucide defaults", () => {
  it("preserves explicit stroke widths while normalizing Lucide's default", () => {
    const selector =
      'svg[class*="lucide"][stroke-width="2"]:not([data-stroke])';

    expect(readRuleBody(globalCss, selector)).toMatch(
      /stroke-width:\s*var\(--stroke-width-icon\);/,
    );
  });

  it("renders more icons as solid dots", () => {
    const selector =
      "svg.lucide-ellipsis circle,\n  svg.lucide-ellipsis-vertical circle";

    expect(readRuleBody(globalCss, selector)).toMatch(/fill:\s*currentColor;/);
  });
});

describe("dialog motion", () => {
  it("fades and translates dialog content in both directions", () => {
    expect(readRuleBody(globalCss, "@keyframes okou-dialog-popup-in")).toMatch(
      /from\s*{[\s\S]*?opacity:\s*0;[\s\S]*?translateY\(8px\)[\s\S]*?to\s*{[\s\S]*?opacity:\s*1;[\s\S]*?translateY\(0\)/,
    );
    expect(readRuleBody(globalCss, "@keyframes okou-dialog-popup-out")).toMatch(
      /from\s*{[\s\S]*?opacity:\s*1;[\s\S]*?translateY\(0\)[\s\S]*?to\s*{[\s\S]*?opacity:\s*0;[\s\S]*?translateY\(8px\)/,
    );
  });
});

describe("interaction state ladder", () => {
  it.each(THEMES)(
    "gives $name a layer colour and every alpha",
    ({ selector }) => {
      const theme = readRuleBody(globalCss, selector);

      expect(theme).toMatch(/--state-layer:\s*[\d.]+ [\d.]+% [\d.]+%;/);
      for (const name of [
        "hover",
        "selected",
        "selected-hover",
        "pressed",
        "on-filled-hover",
        "on-filled-pressed",
      ]) {
        expect(() => {
          return readAlpha(theme, name);
        }).not.toThrow();
      }
    },
  );

  // The ordering defect this ladder replaces let an unselected row outweigh the
  // selected one. Pin the ladder so a future tweak cannot reintroduce it.
  it.each(THEMES)(
    "keeps $name's neutral states strictly increasing",
    ({ selector }) => {
      const theme = readRuleBody(globalCss, selector);

      const hover = readAlpha(theme, "hover");
      const selected = readAlpha(theme, "selected");
      const selectedHover = readAlpha(theme, "selected-hover");
      const pressed = readAlpha(theme, "pressed");

      expect(hover).toBeLessThan(selected);
      expect(selected).toBeLessThan(selectedHover);
      expect(selectedHover).toBeLessThan(pressed);
    },
  );

  it.each(THEMES)(
    "keeps $name's filled states strictly increasing",
    ({ selector }) => {
      const theme = readRuleBody(globalCss, selector);

      expect(readAlpha(theme, "on-filled-hover")).toBeLessThan(
        readAlpha(theme, "on-filled-pressed"),
      );
    },
  );

  // A translucent layer replaces an opaque fill instead of sitting on it, so
  // every surface that carries one needs a pre-mixed pair derived from the
  // same alphas.
  it.each([
    "card",
    "input",
    "secondary",
    "primary",
    "destructive",
    "interrupt",
  ])("derives %s's hover from the shared state alphas", (surface) => {
    expect(globalCss).toContain(`--color-${surface}-hover: color-mix(`);
  });

  it("uses the shared filled-state ladder for the Amber primary", () => {
    expect(readDeclarationValue(globalCss, "color-primary-hover")).toContain(
      "var(--state-on-filled-hover-alpha)",
    );
    expect(readDeclarationValue(globalCss, "color-primary-pressed")).toContain(
      "var(--state-on-filled-pressed-alpha)",
    );
  });
});

describe("primary palette", () => {
  it.each([
    { name: "light", selector: ":root" },
    { name: "dark", selector: ".dark," },
  ])("pairs Amber with Ink in $name", ({ selector }) => {
    const properties = readCustomProperties(readRuleBody(globalCss, selector));

    expect(rgbToHex(color(properties, "--primary"))).toBe("#FFA500");
    expect(rgbToHex(color(properties, "--primary-foreground"))).toBe("#242321");
    expect(
      contrastRatio(
        color(properties, "--primary-foreground"),
        color(properties, "--primary"),
      ),
    ).toBeGreaterThanOrEqual(7.9);
  });
});

describe("neutral gray palette", () => {
  const grayStops = [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
  const themes = [
    {
      anchorStop: 100,
      name: "light",
      selector: ":root",
      textStop: 700,
      uiStop: 600,
      worstSurface: "--sidebar-rail",
    },
    {
      anchorStop: 950,
      name: "dark",
      selector: ".dark,",
      textStop: 800,
      uiStop: 600,
      worstSurface: "--accent",
    },
  ];

  it.each(themes)(
    "keeps $name neutral, monotonic, and anchored on Linen",
    ({ anchorStop, name, selector }) => {
      const properties = readCustomProperties(
        readRuleBody(globalCss, selector),
      );
      const ramp = grayStops.map((stop) => {
        return color(properties, `--gray-${String(stop)}`);
      });
      const luminances = ramp.map(relativeLuminance);

      expect(rgbToHex(color(properties, `--gray-${String(anchorStop)}`))).toBe(
        "#FAF5F3",
      );
      expect(
        ramp.every((rgb) => {
          return Math.max(...rgb) - Math.min(...rgb) <= 8;
        }),
      ).toBe(true);
      for (let index = 1; index < luminances.length; index += 1) {
        const previous = luminances[index - 1];
        const current = luminances[index];
        if (previous === undefined || current === undefined) {
          throw new Error(
            `Missing ${name} gray stop at index ${String(index)}`,
          );
        }
        expect(name === "light" ? current < previous : current > previous).toBe(
          true,
        );
      }
    },
  );

  it.each(themes)(
    "gives $name UI and text stops WCAG safety margins",
    ({ selector, textStop, uiStop, worstSurface }) => {
      const properties = readCustomProperties(
        readRuleBody(globalCss, selector),
      );
      const surface = color(properties, worstSurface);

      expect(
        contrastRatio(color(properties, `--gray-${String(uiStop)}`), surface),
      ).toBeGreaterThanOrEqual(3.05);
      expect(
        contrastRatio(color(properties, `--gray-${String(textStop)}`), surface),
      ).toBeGreaterThanOrEqual(4.55);
      expect(
        contrastRatio(color(properties, "--foreground"), surface),
      ).toBeGreaterThanOrEqual(7);
    },
  );

  it.each(themes)("keeps $name semantic text at WCAG AA", ({ selector }) => {
    const properties = readCustomProperties(readRuleBody(globalCss, selector));
    const pairs = [
      ["--foreground", "--background"],
      ["--card-foreground", "--card"],
      ["--popover-foreground", "--popover"],
      ["--secondary-foreground", "--secondary"],
      ["--muted-foreground", "--muted"],
      ["--accent-foreground", "--accent"],
      ["--sidebar-foreground", "--sidebar"],
      ["--primary-foreground", "--primary"],
      ["--destructive-foreground", "--destructive"],
    ] as const;

    for (const [foreground, background] of pairs) {
      expect(
        contrastRatio(
          color(properties, foreground),
          color(properties, background),
        ),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the dialog overlay on Ink when theme-aware grays invert", () => {
    const lightProperties = readCustomProperties(
      readRuleBody(globalCss, ":root"),
    );
    const darkProperties = new Map(lightProperties);
    for (const [name, value] of readCustomProperties(
      readRuleBody(globalCss, ".dark,"),
    )) {
      darkProperties.set(name, value);
    }

    expect(rgbToHex(color(lightProperties, "--overlay"))).toBe("#242321");
    expect(rgbToHex(color(darkProperties, "--overlay"))).toBe("#242321");
  });
});

// The rail caption and the two composer placeholders draw their color through a
// Tailwind opacity modifier, so the token alone says nothing about what a user
// reads -- only the composite against the surface behind it does.
describe("opacity-modified text", () => {
  const cases = [
    {
      alpha: 0.8,
      background: "--card",
      foreground: "--muted-foreground",
      name: "light composer placeholder",
      selector: ":root",
    },
    {
      alpha: 0.8,
      background: "--card",
      foreground: "--muted-foreground",
      name: "dark composer placeholder",
      selector: ".dark,",
    },
    {
      alpha: 0.7,
      background: "--sidebar-rail",
      foreground: "--sidebar-foreground",
      name: "light rail caption",
      selector: ":root",
    },
    {
      alpha: 0.7,
      background: "--sidebar-rail",
      foreground: "--sidebar-foreground",
      name: "dark rail caption",
      selector: ".dark,",
    },
  ];

  it.each(cases)(
    "keeps the $name at WCAG AA once the opacity modifier is composited",
    ({ alpha, background, foreground, selector }) => {
      const properties = readCustomProperties(
        readRuleBody(globalCss, selector),
      );
      const surface = color(properties, background);
      const text = composite(surface, color(properties, foreground), alpha);
      expect(contrastRatio(text, surface)).toBeGreaterThanOrEqual(4.5);
    },
  );
});

// The segment control is only legible when its track separates from the page
// and the white selection separates from the track. Under the new palette both
// gaps ran through `--muted`'s gray-100, which clears 1.06:1 against white, so
// the whole control dissolved. The track owns its own token now.
describe("segment control track", () => {
  it("gives the track a token that separates it from the page", () => {
    expect(globalCss).toContain(
      "--color-segment-track: hsl(var(--segment-track));",
    );
    expect(readRuleBody(globalCss, "  :root")).toMatch(
      /--segment-track:\s*var\(--gray-200\);/,
    );
  });

  // Chrome keeps the ramp's warm Ink; only content goes neutral, so the two nav
  // columns must not follow the body copy off `--gray-950`.
  it("keeps body copy neutral while the sidebar stays on Ink", () => {
    const lightTheme = readRuleBody(globalCss, ":root");

    expect(lightTheme).toMatch(/--foreground:\s*0 0% 14\.1%;/);
    expect(lightTheme).toMatch(/--sidebar-foreground:\s*var\(--gray-950\);/);
  });
});
