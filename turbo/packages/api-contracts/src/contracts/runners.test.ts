import { describe, expect, it } from "vitest";

import {
  piLaunchConfigSchema,
  piLaunchPayloadSchema,
  piMemoryPhase2MaintenanceSchema,
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

  it("strictly bounds the versioned private maintenance payload", () => {
    const candidate = {
      piSessionId: "11111111-1111-4111-8111-111111111111",
      sourceRunId: "22222222-2222-4222-8222-222222222222",
      sourceHistoryHash: "b".repeat(64),
      sourceCompletedAt: "2026-09-05T02:00:00.000Z",
      rawMemory: "private candidate",
      rolloutSummary: "private evidence",
      rolloutSlug: null,
    };
    const maintenance = {
      schemaVersion: 1 as const,
      memoryStorageId: "1d09f0c9-a5c6-4f21-9664-d80a3ca3ae63",
      claimedRevision: 7,
      claimedBaseVersionId: "a".repeat(64),
      leaseToken: "44754115-d375-4c46-aea7-a55bd1b61ec7",
      selectionDigest: "c".repeat(64),
      selected: [candidate],
    };

    expect(piMemoryPhase2MaintenanceSchema.parse(maintenance)).toStrictEqual(
      maintenance,
    );
    expect(
      piLaunchConfigSchema.parse({
        schemaVersion: 2,
        maintenance,
      }).maintenance,
    ).toStrictEqual(maintenance);
    expect(
      piMemoryPhase2MaintenanceSchema.safeParse({
        ...maintenance,
        selected: [candidate, candidate],
      }).success,
    ).toBe(false);
    expect(
      piMemoryPhase2MaintenanceSchema.safeParse({
        ...maintenance,
        futureField: true,
      }).success,
    ).toBe(false);
  });
});
