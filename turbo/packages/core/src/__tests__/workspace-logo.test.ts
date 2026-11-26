import { describe, expect, it } from "vitest";

import { deltaE2000 } from "../agent-avatar-texture";
import {
  isWideWorkspaceInitial,
  WORKSPACE_LOGO_COLORWAYS,
  workspaceInitial,
  workspaceLogoColorway,
} from "../workspace-logo";

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => {
      return y - x;
    },
  );
  return (light! + 0.05) / (dark! + 0.05);
}

describe("workspace logo colourway", () => {
  it("keeps every texture a ground rather than a pattern", () => {
    // The brand library splits cleanly on this number: tonal tiles sit at
    // 6–11, patterned tiles at 34 and up.
    for (const { ground, ink } of WORKSPACE_LOGO_COLORWAYS) {
      expect(deltaE2000(ground, ink), `${ground}/${ink}`).toBeLessThanOrEqual(
        12,
      );
    }
  });

  it("keeps one workspace on one colourway across calls", () => {
    const first = workspaceLogoColorway("org_3e46915f");

    expect(workspaceLogoColorway("org_3e46915f")).toBe(first);
    expect(WORKSPACE_LOGO_COLORWAYS).toContain(first);
  });

  it("reaches every colourway rather than settling on a few", () => {
    const used = new Set(
      Array.from({ length: 200 }, (_, index) => {
        return workspaceLogoColorway(`org_${index.toString(36)}`);
      }),
    );

    expect(used.size).toBe(WORKSPACE_LOGO_COLORWAYS.length);
  });

  it("keeps every initial legible on both tones of its texture", () => {
    for (const { ground, ink, letter } of WORKSPACE_LOGO_COLORWAYS) {
      const worst = Math.min(
        contrastRatio(letter, ground),
        contrastRatio(letter, ink),
      );
      expect(worst, `${letter} on ${ground}/${ink}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("workspace initial", () => {
  it.each([
    ["Acme Inc", "A"],
    ["okou team", "O"],
    ["  élan studio", "É"],
    ["123 Labs", "1"],
    ["字节跳动", "字"],
    ["한국 팀", "한"],
    ["شركة النور", "ش"],
    ["ßeta GmbH", "ß"],
    ["🚀 Launch Team", "L"],
  ])("takes %s as %s", (name, initial) => {
    expect(workspaceInitial(name)).toBe(initial);
  });

  it.each(["workspace-3f9a2c1d", "👋🎉", "   ", ""])(
    "leaves %j to the texture alone",
    (name) => {
      expect(workspaceInitial(name)).toBeNull();
    },
  );

  it("keeps a renamed workspace with the generated prefix", () => {
    expect(workspaceInitial("workspace-design")).toBe("W");
  });

  it("sets CJK initials smaller than Latin ones", () => {
    expect(isWideWorkspaceInitial("字")).toBe(true);
    expect(isWideWorkspaceInitial("한")).toBe(true);
    expect(isWideWorkspaceInitial("A")).toBe(false);
  });
});
