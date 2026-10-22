import { describe, expect, it } from "vitest";

import {
  piLaunchConfigSchema,
  piLaunchPayloadSchema,
  piResourceSnapshotSchema,
} from "./runners";

describe("Pi memory recall contracts", () => {
  it("accepts legacy V1 snapshots without rewriting their JSON", () => {
    const v1 = { schemaVersion: 1 as const, agentsFiles: [], skills: [] };
    expect(piResourceSnapshotSchema.parse(v1)).toStrictEqual(v1);
    expect(JSON.stringify(piResourceSnapshotSchema.parse(v1))).toBe(
      '{"schemaVersion":1,"agentsFiles":[],"skills":[]}',
    );
  });

  it("strictly accepts authenticated and explicit no-content V2 snapshots", () => {
    const noContent = {
      schemaVersion: 2 as const,
      agentsFiles: [],
      skills: [],
      memoryRecall: {
        status: "no-content" as const,
        memoryStorageId: "memory-storage",
        storageVersionId: "version-a",
      },
    };
    expect(piResourceSnapshotSchema.parse(noContent)).toStrictEqual(noContent);

    const ready = {
      ...noContent,
      memoryRecall: {
        status: "ready" as const,
        memoryStorageId: "memory-storage",
        storageVersionId: "version-a",
        content: "bounded summary",
        sourceHash: "b".repeat(64),
        sourceSize: 15,
        tokenCount: 2,
      },
    };
    expect(piResourceSnapshotSchema.parse(ready)).toStrictEqual(ready);
    expect(
      piResourceSnapshotSchema.safeParse({
        ...ready,
        memoryRecall: { ...ready.memoryRecall, path: "../../secret" },
      }).success,
    ).toBe(false);
    expect(
      piResourceSnapshotSchema.safeParse({ ...noContent, extra: true }).success,
    ).toBe(false);
    expect(
      piResourceSnapshotSchema.safeParse({ ...noContent, schemaVersion: 3 })
        .success,
    ).toBe(false);
  });

  it("keeps the private launch payload byte-compatible when recall is absent", () => {
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
