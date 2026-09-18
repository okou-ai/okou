import type {
  PiStableContextBuildInput,
  PiStableContextProjection,
  PiStableContextPromptInputs,
} from "@okouai/db/jsonb-contracts/pi-stable-context";
import { describe, expect, it } from "vitest";

import {
  bindPiStableContextProjection,
  piStableContextArtifactDigest,
  piStableContextProjectionFromInput,
  piStableContextVariantDigest,
} from "../pi-stable-context.service";
import { customConnectorDefinitionHasStableSkill } from "../pi-stable-context-recapture.service";
import { normalizeMountOverlay } from "../storage-mount-overlay";

describe("Pi stable context projection", () => {
  const input: PiStableContextBuildInput = {
    schemaVersion: 1,
    owner: {
      orgId: "org-a",
      userId: "user-a",
      agentId: "00000000-0000-4000-8000-000000000001",
      resourceOwner: { orgId: "org-a", userId: "owner-a" },
    },
    source: {
      agentGeneration: 4,
      userGeneration: 7,
      catalogIdentity: "catalog-a",
      catalogSourceId: "source-a",
      agentIdentityDigest: "agent-identity-a",
      featurePromptDigest: "feature-a",
      permissionDigest: "permission-a",
      connectorScopeDigest: "connector-a",
      validityHorizon: "2026-09-18T00:00:00.000Z",
      promptSchemaVersion: 1,
      runtimeSchemaVersion: 1,
      extractorVersion: 1,
    },
    prompt: {
      agentIdentity: "You are Example.",
      executionLimit: "Finish within the captured limit.",
      tools: "Use the exact registered tools.",
    },
    storageMounts: [
      {
        orgId: "org-a",
        userId: "owner-a",
        name: "agent",
        storageId: "00000000-0000-4000-8000-000000000010",
        versionId: "a".repeat(64),
        mountPath: "/home/oai/share",
        archiveSize: 100,
      },
      {
        orgId: "org-a",
        userId: "owner-a",
        name: "project",
        storageId: "00000000-0000-4000-8000-000000000011",
        versionId: "b".repeat(64),
        mountPath: "/home/oai/share",
        archiveSize: 200,
      },
    ],
    persistedStorageMounts: [
      {
        orgId: "org-a",
        userId: "owner-a",
        name: "agent",
        storageId: "00000000-0000-4000-8000-000000000010",
        version: "a".repeat(64),
        mountPath: "/home/oai/share",
      },
      {
        orgId: "org-a",
        userId: "owner-a",
        name: "project",
        storageId: "00000000-0000-4000-8000-000000000011",
        version: "b".repeat(64),
        mountPath: "/home/oai/share",
      },
    ],
  };

  const resourceSnapshot = {
    schemaVersion: 1 as const,
    agentsFiles: [
      { path: "/home/oai/share/AGENTS.md", content: "last mount wins" },
    ],
    skills: [
      {
        name: "release-check",
        description: "Inspect a release.",
        filePath: "/home/oai/share/skills/release-check/SKILL.md",
        baseDir: "/home/oai/share/skills/release-check",
        scope: "project" as const,
        disableModelInvocation: false,
      },
    ],
  };

  it("preserves canonical content, mount order, prompt metadata, and owner bindings", () => {
    const projection = piStableContextProjectionFromInput(
      input,
      resourceSnapshot,
    );

    expect(projection).toStrictEqual({ ...input, resourceSnapshot });
    expect(
      projection.storageMounts.map((mount) => {
        return mount.name;
      }),
    ).toStrictEqual(["agent", "project"]);
    expect(projection.prompt).toStrictEqual(input.prompt);
    expect(projection.resourceSnapshot).toStrictEqual(resourceSnapshot);
  });

  it("binds frozen memory after the immutable resource artifact", () => {
    const projection = piStableContextProjectionFromInput(
      input,
      resourceSnapshot,
    );
    const noMemory = bindPiStableContextProjection(projection, undefined);
    const noContent = bindPiStableContextProjection(projection, {
      status: "no-content",
      memoryStorageId: "00000000-0000-4000-8000-000000000020",
      storageVersionId: "c".repeat(64),
    });
    const ready = bindPiStableContextProjection(projection, {
      status: "ready",
      memoryStorageId: "00000000-0000-4000-8000-000000000020",
      storageVersionId: "c".repeat(64),
      content: "Frozen memory.",
      sourceHash: "d".repeat(64),
      sourceSize: 14,
      tokenCount: 3,
    });

    expect(noMemory.snapshot).toStrictEqual(resourceSnapshot);
    expect(noContent.snapshot).toMatchObject({
      schemaVersion: 2,
      memoryRecall: { status: "no-content" },
    });
    expect(ready.snapshot).toMatchObject({
      schemaVersion: 2,
      memoryRecall: { status: "ready", content: "Frozen memory." },
    });
    expect(
      new Set([noMemory.digest, noContent.digest, ready.digest]).size,
    ).toBe(3);
    expect(piStableContextArtifactDigest(projection)).toBe(
      piStableContextArtifactDigest(projection),
    );
  });

  it("uses canonical last-wins mount overlay order", () => {
    const mounts = normalizeMountOverlay([
      { mountPath: "/skills/github", source: "builtin" },
      { mountPath: "/skills/intro-video", source: "intro" },
      { mountPath: "/skills/github", source: "workflow" },
    ]);

    expect(mounts).toStrictEqual([
      { mountPath: "/skills/intro-video", source: "intro" },
      { mountPath: "/skills/github", source: "workflow" },
    ]);
  });

  it("filters MCP custom skills when their feature is disabled", () => {
    const promptInputs: PiStableContextPromptInputs = {
      privateArtifactsEnabled: false,
      cloudBrowserEnabled: false,
      bankingEnabled: false,
      vncEnabled: false,
      larkEnabled: false,
      deliveryFormatGuidanceEnabled: false,
      customConnectorMcpEnabled: false,
      triggerSource: "web",
    };
    const definition = {
      customConnectorId: "00000000-0000-4000-8000-000000000030",
      connectorSlug: "custom-mcp",
      storageVersion: 1,
      skillStorageVersionId: "e".repeat(64),
      isMcp: true,
    };

    expect(
      customConnectorDefinitionHasStableSkill(definition, promptInputs),
    ).toBeFalsy();
    expect(
      customConnectorDefinitionHasStableSkill(definition, {
        ...promptInputs,
        customConnectorMcpEnabled: true,
      }),
    ).toBeTruthy();
  });

  it("does not reuse artifacts across owner or semantic generations", () => {
    const projection = piStableContextProjectionFromInput(
      input,
      resourceSnapshot,
    );
    const otherOwner: PiStableContextProjection = {
      ...projection,
      owner: { ...projection.owner, userId: "user-b" },
    };
    const newerCatalog: PiStableContextProjection = {
      ...projection,
      source: { ...projection.source, catalogIdentity: "catalog-b" },
    };

    expect(piStableContextArtifactDigest(otherOwner)).not.toBe(
      piStableContextArtifactDigest(projection),
    );
    expect(piStableContextArtifactDigest(newerCatalog)).not.toBe(
      piStableContextArtifactDigest(projection),
    );
    expect(piStableContextVariantDigest({ a: 1, nested: { b: 2 } })).toBe(
      piStableContextVariantDigest({ nested: { b: 2 }, a: 1 }),
    );
  });
});
