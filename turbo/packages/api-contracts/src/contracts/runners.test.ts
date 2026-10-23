import { describe, expect, it } from "vitest";

import {
  piLaunchConfigSchema,
  piLaunchPayloadSchema,
  piResourceSnapshotSchema,
} from "./runners";

describe("Pi resource and launch contracts", () => {
  it("preserves resource snapshot JSON", () => {
    const v1 = { schemaVersion: 1 as const, agentsFiles: [], skills: [] };
    expect(piResourceSnapshotSchema.parse(v1)).toStrictEqual(v1);
    expect(JSON.stringify(piResourceSnapshotSchema.parse(v1))).toBe(
      '{"schemaVersion":1,"agentsFiles":[],"skills":[]}',
    );
  });

  it("preserves private launch payload JSON", () => {
    const launchConfig = { schemaVersion: 2 as const };
    expect(piLaunchConfigSchema.parse(launchConfig)).toStrictEqual(
      launchConfig,
    );
    const payload = {
      schemaVersion: 1 as const,
      appendSystemPrompt: "caller instructions",
      launchConfig,
    };
    expect(JSON.stringify(piLaunchPayloadSchema.parse(payload))).toBe(
      JSON.stringify(payload),
    );
  });
});
