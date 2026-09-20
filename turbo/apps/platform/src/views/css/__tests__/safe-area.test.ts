/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// The shell's stylesheet is the only place these properties exist. A rendered
// page cannot observe them: the test DOM never compiles or applies Tailwind, so
// there is no computed value to read.
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

// Only the split between the physical inset and the avoidable one belongs
// here. The four `env()` declarations and the shell's own padding are unchanged
// configuration, and restating them would pin the file rather than a decision.
describe("safe-area properties", () => {
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
});
