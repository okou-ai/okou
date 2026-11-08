import { describe, expect, it } from "vitest";
import { claimedContentBundlesSchema } from "../content-bundle";
import { runContextArchiveSchema } from "../run-context-archive";
import {
  storedTemplateGuidanceBundleSchema,
  templateGuidanceBundleSchema,
} from "../template-guidance-bundle";

const template = {
  ownerKind: "user-template",
  beforeMountPaths: [],
  templateId: "859550cb-28ad-47ef-8728-f6b3849f8c55",
  sha256: "a".repeat(64),
  archiveBytes: 40 * 1024 * 1024,
};

describe("template guidance claim and retained context", () => {
  it("accepts the dedicated envelope without defaulting fields for legacy claims", () => {
    const legacy = claimedContentBundlesSchema.parse({
      format: "tar-gzip-v1",
      skills: [],
    });
    expect(legacy).not.toHaveProperty("templates");
    const claimed = claimedContentBundlesSchema.parse({
      ...legacy,
      templates: [{ ...template, downloadUrl: "https://example.test/archive" }],
    });
    expect(claimed.templates).toHaveLength(1);
    expect(
      templateGuidanceBundleSchema.safeParse({
        sha256: template.sha256,
        archiveBytes: 103 * 1024 * 1024,
      }).success,
    ).toBe(true);
    for (const archiveBytes of [0, -1, 1.5, 103 * 1024 * 1024 + 1]) {
      expect(
        templateGuidanceBundleSchema.safeParse({
          sha256: template.sha256,
          archiveBytes,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects writable or arbitrary-path template claims and credential-bearing URLs", () => {
    expect(
      storedTemplateGuidanceBundleSchema.safeParse({
        ...template,
        ownerKind: "unknown",
      }).success,
    ).toBe(false);
    expect(
      storedTemplateGuidanceBundleSchema.safeParse({
        ...template,
        mountPath: "/home/user",
      }).success,
    ).toBe(false);
    for (const extra of [
      { writeback: true },
      { downloadUrl: "http://example.test/archive" },
      { downloadUrl: "https://secret@example.test/archive" },
    ]) {
      expect(
        claimedContentBundlesSchema.safeParse({
          format: "tar-gzip-v1",
          skills: [],
          templates: [
            {
              ...template,
              downloadUrl: "https://example.test/archive",
              ...extra,
            },
          ],
        }).success,
      ).toBe(false);
    }
  });

  it("retains owner identity and digest in downloaded run context without Storage IDs", () => {
    const context = {
      prompt: "run",
      appendSystemPrompt: null,
      runId: "run",
      sessionId: null,
      secretNames: [],
      vars: null,
      environment: {},
      firewalls: [],
      networkPolicies: null,
      storageMounts: [],
      featureFlags: null,
    };
    expect(runContextArchiveSchema.parse(context)).not.toHaveProperty(
      "templateGuidanceBundles",
    );
    const parsed = runContextArchiveSchema.parse({
      ...context,
      templateGuidanceBundles: [template],
    });
    expect(parsed.templateGuidanceBundles).toEqual([template]);
    expect(parsed.storageMounts).toEqual([]);
  });
});
