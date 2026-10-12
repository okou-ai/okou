import { describe, expect, it } from "vitest";

import {
  officialWorkflowCatalogDetailSchema,
  officialWorkflowInstallationDefinitionSchema,
} from "../official-workflows";

const REVISION = "a".repeat(64);
const FINGERPRINT = "b".repeat(64);

const blueprint = {
  key: "daily-brief",
  parameters: [
    {
      key: "topic",
      type: "string" as const,
      format: "text" as const,
      required: true,
    },
    {
      key: "max-items",
      type: "integer" as const,
      required: true,
      default: 10,
    },
    {
      key: "include-weekends",
      type: "boolean" as const,
      required: true,
      default: false,
    },
  ],
  desiredState: {
    kind: "schedule" as const,
    schedule: {
      type: "loop" as const,
      intervalSeconds: 3600,
    },
  },
  fingerprint: FINGERPRINT,
};

describe("Official Workflow product contracts", () => {
  it("represents retained retired catalog detail", () => {
    const detail = {
      name: "team-brief",
      revision: REVISION,
      lifecycle: "retired" as const,
      displayName: "Team Brief",
      description: "A retained Official Workflow revision.",
      blueprints: [blueprint],
      presentation: { category: "productivity", order: 1 },
      workflow: {
        displayName: "Team Brief",
        description: "A retained Official Workflow revision.",
        instruction: "Prepare the brief.",
        files: [{ path: "references/context.md", content: "Context" }],
      },
    };

    expect(officialWorkflowCatalogDetailSchema.parse(detail)).toStrictEqual(
      detail,
    );
  });

  it("carries every declared parameter type in authoritative installation metadata", () => {
    const definition = {
      name: "team-brief",
      revision: REVISION,
      lifecycle: "active" as const,
      blueprints: [blueprint],
    };

    expect(
      officialWorkflowInstallationDefinitionSchema.parse(definition),
    ).toStrictEqual(definition);
    expect(
      officialWorkflowInstallationDefinitionSchema.safeParse({
        ...definition,
        lifecycle: "unavailable",
      }).success,
    ).toBe(false);
  });
});
