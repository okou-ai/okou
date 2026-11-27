import { describe, expect, it } from "vitest";
import { executionContentBundlesSchema } from "../content-bundle";
import { runContextArchiveSchema } from "../run-context-archive";
import {
  storedTemplateGuidanceBundleSchema,
  templateGuidanceBundleSchema,
} from "../template-guidance-bundle";

const template = {
  ownerKind: "user-template",
  templateId: "859550cb-28ad-47ef-8728-f6b3849f8c55",
  sha256: "a".repeat(64),
  archiveBytes: 40 * 1024 * 1024,
};

describe("template guidance execution and retained context", () => {
  it("accepts template bundles while leaving optional fields absent when no template is selected", () => {
    const withoutTemplates = executionContentBundlesSchema.parse({
      format: "tar-gzip-v1",
      skills: [],
    });
    expect(withoutTemplates).not.toHaveProperty("templates");
    const execution = executionContentBundlesSchema.parse({
      ...withoutTemplates,
      templates: [{ ...template, downloadUrl: "https://example.test/archive" }],
    });
    expect(execution.templates).toHaveLength(1);
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

  it("validates stored templates and only reads recognized dispatch fields", () => {
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
    expect(
      storedTemplateGuidanceBundleSchema.safeParse({
        ...template,
        templateId: "../../escape",
      }).success,
    ).toBe(false);
    const reference = {
      ...template,
      downloadUrl: "https://example.test/archive",
    };
    expect(
      executionContentBundlesSchema.parse({
        format: "tar-gzip-v1",
        skills: [],
        templates: [{ ...reference, writeback: true, mountPath: "/home/user" }],
      }).templates,
    ).toEqual([reference]);
    for (const downloadUrl of [
      "http://example.test/archive",
      "https://secret@example.test/archive",
    ]) {
      expect(
        executionContentBundlesSchema.safeParse({
          format: "tar-gzip-v1",
          skills: [],
          templates: [{ ...template, downloadUrl }],
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
    const current = {
      ...template,
      templateId: "f0fbad48-3d7f-4468-83d1-221e9a27a1a9",
    };
    const parsed = runContextArchiveSchema.parse({
      ...context,
      templateGuidanceBundles: [
        {
          ...template,
          beforeMountPaths: ["/home/user/.claude/skills/example"],
        },
        current,
      ],
    });
    expect(parsed.templateGuidanceBundles).toStrictEqual([template, current]);
    expect(parsed.storageMounts).toEqual([]);
  });
});
