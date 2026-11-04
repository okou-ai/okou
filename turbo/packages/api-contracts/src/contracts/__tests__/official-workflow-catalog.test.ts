import { describe, expect, it } from "vitest";

import {
  officialWorkflowCatalogReleasePayloadSchema,
  officialWorkflowDefinitionRevisionPayloadSchema,
} from "../official-workflow-catalog";

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

function catalogPayload(blueprints: unknown[]) {
  return {
    schemaVersion: 4,
    definitions: [
      {
        name: "morning-brief",
        lifecycle: "active",
        revision: REVISION,
        contentBundle: { sha256: "c".repeat(64), archiveBytes: 200 },
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
});

describe("bundle-backed Official catalogs", () => {
  it.each([
    { lifecycle: "active", blueprint: v3Blueprint },
    { lifecycle: "retired", blueprint: v2Blueprint },
  ])(
    "reads v4 $lifecycle delivery without changing business identity",
    ({ lifecycle, blueprint }) => {
      const current = catalogPayload([blueprint]);
      const original = current.definitions[0];
      if (!original) {
        throw new Error("Expected a definition");
      }
      const catalog = {
        ...current,
        definitions: [{ ...original, lifecycle }],
      };
      expect(
        officialWorkflowCatalogReleasePayloadSchema.parse(catalog),
      ).toStrictEqual(catalog);
    },
  );
});
