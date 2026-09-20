/// <reference types="node" />

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The shell's stylesheet is the only place these properties exist. A rendered
// page cannot observe them: the test DOM never compiles or applies Tailwind, so
// there is no computed value to read.
const entrypointCss = readFileSync(
  fileURLToPath(new URL("../index.css", import.meta.url)),
  "utf8",
);

/** Returns the declaration body of the first rule introduced by `selector`. */
function readRuleBody(selector: string): string {
  const start = entrypointCss.indexOf(selector);
  if (start === -1) {
    throw new Error(`Unable to locate CSS rule for ${selector}`);
  }
  const open = entrypointCss.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < entrypointCss.length; index += 1) {
    if (entrypointCss[index] === "{") {
      depth += 1;
      continue;
    }
    if (entrypointCss[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return entrypointCss.slice(open + 1, index);
      }
    }
  }
  throw new Error(`Unterminated CSS rule for ${selector}`);
}

describe("safe-area properties", () => {
  it("reads every inset from its environment variable", () => {
    const root = readRuleBody(":root {");

    expect(root).toMatch(/--sat:\s*env\(safe-area-inset-top, 0px\);/);
    expect(root).toMatch(/--sar:\s*env\(safe-area-inset-right, 0px\);/);
    expect(root).toMatch(/--sab:\s*env\(safe-area-inset-bottom, 0px\);/);
    expect(root).toMatch(/--sal:\s*env\(safe-area-inset-left, 0px\);/);
  });

  it("starts the avoidable bottom inset at the physical one", () => {
    expect(readRuleBody(":root {")).toMatch(/--okou-safe-b:\s*var\(--sab\);/);
  });

  // The keyboard covers the home indicator while it is up, so a surface resting
  // on the keyboard owes nothing there. Reserving the inset anyway leaves a gap
  // between that surface and the keyboard. The correction lives on the document
  // root rather than a subtree so a body-level portal inherits it too.
  it("retires the avoidable bottom inset while the keyboard is open", () => {
    expect(readRuleBody(':root[data-keyboard-open="true"] {')).toMatch(
      /--okou-safe-b:\s*0px;/,
    );
  });

  // Fills that paint past the viewport edge still need the physical reserve, so
  // the correction must not reach the property they read.
  it("keeps the physical inset unchanged while the keyboard is open", () => {
    expect(readRuleBody(':root[data-keyboard-open="true"] {')).not.toContain(
      "--sab:",
    );
  });

  // Fixed descendants are laid out past this padding box, which is why they
  // carry their own insets; the shell still owns the three it can apply.
  it("keeps the shell's own top and horizontal padding", () => {
    expect(readRuleBody("#root {\n  box-sizing")).toMatch(
      /padding:\s*var\(--sat\)\s*var\(--sar\)\s*0\s*var\(--sal\);/,
    );
  });
});
