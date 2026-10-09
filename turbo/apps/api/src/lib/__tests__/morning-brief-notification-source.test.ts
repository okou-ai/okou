import { describe, expect, it } from "vitest";
import { isMorningBriefNotificationSource } from "../morning-brief-notification-source";

// Pure security-policy coverage: origin authorization must not depend on labels
// or on merely mounting an Official skill in an unrelated run.
const owner = Object.freeze({ orgId: "org-owner", userId: "user-owner" });
const run = Object.freeze({
  workflowAutomationId: "morning-automation",
  officialWorkflowProvenance: {
    schemaVersion: 1 as const,
    definitions: [
      {
        name: "morning-brief",
        revision: "accepted-revision",
        artifact: {
          orgId: "official-org",
          userId: "official-owner",
          storageName: "morning-brief",
          storageId: "official-storage",
          storageVersion: "accepted-storage-version",
        },
      },
    ],
  },
});
const source = Object.freeze({
  automationId: "morning-automation",
  automationOrgId: owner.orgId,
  automationOwnerUserId: owner.userId,
  workflowOrgId: owner.orgId,
  workflowOwnerUserId: owner.userId,
  officialDefinitionName: "morning-brief",
  officialBlueprintKey: "daily-delivery",
});

describe("Morning Brief notification source authorization", () => {
  it("accepts an owned official daily-delivery run with accepted provenance", () => {
    expect(isMorningBriefNotificationSource(owner, run, source)).toBeTruthy();
  });

  it.each([
    { automationId: "unrelated-automation" },
    { automationOrgId: "other-org" },
    { automationOwnerUserId: "other-user" },
    { workflowOrgId: "other-org" },
    { workflowOwnerUserId: "other-user" },
    { officialDefinitionName: null },
    { officialDefinitionName: "other-official-workflow" },
    { officialBlueprintKey: null },
    { officialBlueprintKey: "other-blueprint" },
  ])("rejects unrelated, custom, or cross-owner source %j", (change) => {
    expect(
      isMorningBriefNotificationSource(owner, run, { ...source, ...change }),
    ).toBeFalsy();
  });

  it("rejects a mounted Morning Brief skill without a source automation", () => {
    expect(
      isMorningBriefNotificationSource(
        owner,
        { ...run, workflowAutomationId: null },
        source,
      ),
    ).toBeFalsy();
    expect(isMorningBriefNotificationSource(owner, run, undefined)).toBeFalsy();
  });

  it("requires accepted Morning Brief provenance in addition to the live source", () => {
    expect(
      isMorningBriefNotificationSource(
        owner,
        { ...run, officialWorkflowProvenance: null },
        source,
      ),
    ).toBeFalsy();
    expect(
      isMorningBriefNotificationSource(
        owner,
        {
          ...run,
          officialWorkflowProvenance: { schemaVersion: 1, definitions: [] },
        },
        source,
      ),
    ).toBeFalsy();
  });
});
