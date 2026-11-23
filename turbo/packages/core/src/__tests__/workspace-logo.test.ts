import { describe, expect, it } from "vitest";

import { deltaE2000 } from "../agent-avatar-texture";
import {
  WORKSPACE_LOGO_COLORWAYS,
  workspaceLogoColorway,
} from "../workspace-logo";

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
});
