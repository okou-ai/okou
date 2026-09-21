import { describe, expect, it } from "vitest";

import { workflowNameSchema } from "../workflows";
import { normalizeSkillImportName } from "../skill-import";

describe("normalizeSkillImportName", () => {
  it.each([
    ["release-notes", "release-notes"],
    ["Release Notes", "release-notes"],
    ["My_Skill.v2", "my-skill-v2"],
    ["  Weekly   Report  ", "weekly-report"],
    ["--edge--case--", "edge-case"],
    ["写周报 report", "report"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeSkillImportName(input)).toBe(expected);
  });

  it("truncates to the workflow slug length without a trailing hyphen", () => {
    const normalized = normalizeSkillImportName(`${"a".repeat(64)} tail`);

    expect(normalized).toBe("a".repeat(64));
  });

  it("drops a hyphen left at the truncation boundary", () => {
    const normalized = normalizeSkillImportName(`${"a".repeat(63)} tail`);

    expect(normalized).toBe("a".repeat(63));
  });

  it.each(["", "   ", "---", "写周报", "x"])(
    "rejects %j as unusable",
    (input) => {
      expect(normalizeSkillImportName(input)).toBeNull();
    },
  );

  it("always returns a value the workflow name schema accepts", () => {
    const candidates = [
      "Release Notes",
      "My_Skill.v2",
      "--edge--case--",
      "a".repeat(200),
      "-".repeat(200),
    ];

    for (const candidate of candidates) {
      const normalized = normalizeSkillImportName(candidate);
      if (normalized !== null) {
        expect(workflowNameSchema.safeParse(normalized).success).toBeTruthy();
      }
    }
  });
});
