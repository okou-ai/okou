import { describe, expect, it } from "vitest";

import {
  officialWorkflowCatalogReleasePayloadSchema,
  officialWorkflowDefinitionRevisionPayloadSchema,
} from "../official-workflow-catalog";
import { officialWorkflowCatalogDetailSchema } from "../official-workflows";

const REVISION = "a".repeat(64);
const FINGERPRINT = "b".repeat(64);

const v3Blueprint = {
  key: "daily-delivery",
  parameters: [],
  desiredState: {
    kind: "schedule" as const,
    schedule: { type: "cron" as const, cronExpression: "0 7 * * *" },
  },
  fingerprint: FINGERPRINT,
};
const v2Blueprint = { ...v3Blueprint, runtime: { resultEmail: false } };

const workflow = {
  displayName: "Morning Brief",
  description: "Summarize today's priorities.",
  instruction: "Prepare the brief.",
  files: [],
};

function revisionPayload(schemaVersion: number, blueprints: unknown[]) {
  return {
    schemaVersion,
    name: "morning-brief",
    revision: REVISION,
    workflow,
    blueprints,
  };
}

function catalogPayload(schemaVersion: number, blueprints: unknown[]) {
  return {
    schemaVersion,
    definitions: [
      {
        name: "morning-brief",
        lifecycle: "active",
        revision: REVISION,
        artifact: {
          storageName: "official-workflow-morning-brief",
          storageId: "00000000-0000-4000-8000-000000000000",
          storageVersion: FINGERPRINT,
        },
        blueprints,
        releasedBlueprintKeys: ["daily-delivery"],
        presentation: { category: "productivity" },
      },
    ],
  };
}

describe("persisted Official Workflow catalog payloads", () => {
  it("reads revisions strictly by their own schema version", () => {
    const v2 = revisionPayload(2, [v2Blueprint]);
    const v3 = revisionPayload(3, [v3Blueprint]);
    const schema = officialWorkflowDefinitionRevisionPayloadSchema;

    expect(schema.parse(v2)).toStrictEqual(v2);
    expect(schema.parse(v3)).toStrictEqual(v3);
    expect(schema.safeParse(revisionPayload(2, [v3Blueprint])).success).toBe(
      false,
    );
    expect(schema.safeParse(revisionPayload(3, [v2Blueprint])).success).toBe(
      false,
    );
    expect(schema.safeParse(revisionPayload(4, [v3Blueprint])).success).toBe(
      false,
    );
  });

  it("reads accepted catalogs strictly by their own schema version", () => {
    const v2 = catalogPayload(2, [v2Blueprint]);
    const v3 = catalogPayload(3, [v3Blueprint]);
    const schema = officialWorkflowCatalogReleasePayloadSchema;

    expect(schema.parse(v2)).toStrictEqual(v2);
    expect(schema.parse(v3)).toStrictEqual(v3);
    expect(schema.safeParse(catalogPayload(2, [v3Blueprint])).success).toBe(
      false,
    );
    expect(schema.safeParse(catalogPayload(3, [v2Blueprint])).success).toBe(
      false,
    );
    expect(schema.safeParse(catalogPayload(4, [v3Blueprint])).success).toBe(
      false,
    );
  });

  it("returns either supported Blueprint shape in public catalog detail", () => {
    for (const blueprint of [v2Blueprint, v3Blueprint]) {
      const detail = {
        name: "morning-brief",
        revision: REVISION,
        lifecycle: "active" as const,
        displayName: workflow.displayName,
        description: workflow.description,
        blueprints: [blueprint],
        presentation: { category: "productivity" },
        workflow,
      };
      expect(officialWorkflowCatalogDetailSchema.parse(detail)).toStrictEqual(
        detail,
      );
    }
  });
});
