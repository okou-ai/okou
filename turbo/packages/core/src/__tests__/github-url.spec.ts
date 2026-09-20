import { describe, it, expect } from "vitest";
import {
  parseGitHubTreeUrl,
  parseGitHubUrl,
  getSkillNameFromPath,
  resolveSkillRef,
} from "../github-url";

describe("parseGitHubTreeUrl", () => {
  it("parses valid GitHub tree URL", () => {
    const url = "https://github.com/owner/repo/tree/main/path/to/skill";
    const result = parseGitHubTreeUrl(url);

    expect(result).not.toBeNull();
    expect(result?.owner).toBe("owner");
    expect(result?.repo).toBe("repo");
    expect(result?.branch).toBe("main");
    expect(result?.path).toBe("path/to/skill");
    expect(result?.skillName).toBe("skill");
    expect(result?.fullPath).toBe("owner/repo/tree/main/path/to/skill");
  });

  it("extracts skill name from single-segment path", () => {
    const url = "https://github.com/owner/repo/tree/main/skill-name";
    const result = parseGitHubTreeUrl(url);

    expect(result?.skillName).toBe("skill-name");
  });

  it("extracts skill name from deep nested path", () => {
    const url = "https://github.com/owner/repo/tree/main/a/b/c/d/skill";
    const result = parseGitHubTreeUrl(url);

    expect(result?.skillName).toBe("skill");
    expect(result?.path).toBe("a/b/c/d/skill");
  });

  it("handles different branch names", () => {
    const url = "https://github.com/owner/repo/tree/develop/path/to/skill";
    const result = parseGitHubTreeUrl(url);

    expect(result?.branch).toBe("develop");
  });

  it("returns null for non-GitHub URLs", () => {
    const url = "https://gitlab.com/owner/repo/tree/main/path";
    const result = parseGitHubTreeUrl(url);

    expect(result).toBeNull();
  });

  it("returns null for GitHub URLs without tree", () => {
    const url = "https://github.com/owner/repo/blob/main/file.ts";
    const result = parseGitHubTreeUrl(url);

    expect(result).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(parseGitHubTreeUrl("not-a-url")).toBeNull();
    expect(parseGitHubTreeUrl("https://github.com/")).toBeNull();
    expect(parseGitHubTreeUrl("https://github.com/owner")).toBeNull();
    expect(parseGitHubTreeUrl("https://github.com/owner/repo")).toBeNull();
    expect(parseGitHubTreeUrl("https://github.com/owner/repo/tree")).toBeNull();
  });

  it("preserves full path for unique identification", () => {
    const url = "https://github.com/okou/skills/tree/main/conventional-commits";
    const result = parseGitHubTreeUrl(url);

    expect(result?.fullPath).toBe("okou/skills/tree/main/conventional-commits");
  });

  it("handles trailing slash on path", () => {
    const result = parseGitHubTreeUrl(
      "https://github.com/owner/repo/tree/main/path/",
    );
    expect(result).not.toBeNull();
    expect(result?.owner).toBe("owner");
    expect(result?.repo).toBe("repo");
    expect(result?.branch).toBe("main");
    expect(result?.path).toBe("path");
    expect(result?.skillName).toBe("path");
    expect(result?.fullPath).toBe("owner/repo/tree/main/path");
  });
});

describe("parseGitHubUrl", () => {
  it("parses plain repository URL", () => {
    const result = parseGitHubUrl("https://github.com/owner/repo");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      branch: null,
      path: null,
      fullPath: "owner/repo",
    });
  });

  it("parses repository URL with trailing slash", () => {
    const result = parseGitHubUrl("https://github.com/owner/repo/");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      branch: null,
      path: null,
      fullPath: "owner/repo",
    });
  });

  it("parses tree URL without path (root)", () => {
    const result = parseGitHubUrl("https://github.com/owner/repo/tree/main");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      branch: "main",
      path: null,
      fullPath: "owner/repo/tree/main",
    });
  });

  it("parses tree URL with path", () => {
    const result = parseGitHubUrl(
      "https://github.com/owner/repo/tree/main/path/to/dir",
    );
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      branch: "main",
      path: "path/to/dir",
      fullPath: "owner/repo/tree/main/path/to/dir",
    });
  });

  it("handles different branch names", () => {
    const result = parseGitHubUrl(
      "https://github.com/owner/repo/tree/develop/path",
    );
    expect(result?.branch).toBe("develop");
    expect(result?.path).toBe("path");
  });

  it("returns null for non-GitHub URLs", () => {
    expect(parseGitHubUrl("https://gitlab.com/owner/repo")).toBeNull();
  });

  it("returns null for incomplete GitHub URLs", () => {
    expect(parseGitHubUrl("https://github.com/owner")).toBeNull();
    expect(parseGitHubUrl("https://github.com/")).toBeNull();
    expect(parseGitHubUrl("not-a-url")).toBeNull();
  });

  it("returns null for blob URLs", () => {
    expect(
      parseGitHubUrl("https://github.com/owner/repo/blob/main/file.ts"),
    ).toBeNull();
  });

  it("parses tree URL with trailing slash (root)", () => {
    const result = parseGitHubUrl("https://github.com/owner/repo/tree/main/");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      branch: "main",
      path: null,
      fullPath: "owner/repo/tree/main",
    });
  });

  it("parses tree URL with trailing slash (path)", () => {
    const result = parseGitHubUrl(
      "https://github.com/owner/repo/tree/main/path/",
    );
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      branch: "main",
      path: "path",
      fullPath: "owner/repo/tree/main/path",
    });
  });

  it("parses tree URL with trailing slash (deep path)", () => {
    const result = parseGitHubUrl(
      "https://github.com/owner/repo/tree/main/path/to/dir/",
    );
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      branch: "main",
      path: "path/to/dir",
      fullPath: "owner/repo/tree/main/path/to/dir",
    });
  });
});

describe("getSkillNameFromPath", () => {
  it("returns last segment of path", () => {
    expect(getSkillNameFromPath("path/to/skill")).toBe("skill");
  });

  it("handles single segment", () => {
    expect(getSkillNameFromPath("skill")).toBe("skill");
  });

  it("handles deep nesting", () => {
    expect(getSkillNameFromPath("a/b/c/d/skill-name")).toBe("skill-name");
  });

  it("filters empty segments", () => {
    expect(getSkillNameFromPath("path//to///skill")).toBe("skill");
  });

  it("returns path if no segments", () => {
    expect(getSkillNameFromPath("")).toBe("");
  });
});

describe("resolveSkillRef", () => {
  it("expands bare name to default registry URL", () => {
    expect(resolveSkillRef("slack")).toBe(
      "https://github.com/okou-ai/vm0-skills/tree/main/slack",
    );
  });

  it("expands another bare name", () => {
    expect(resolveSkillRef("elevenlabs")).toBe(
      "https://github.com/okou-ai/vm0-skills/tree/main/elevenlabs",
    );
  });

  it("trims whitespace from bare names", () => {
    expect(resolveSkillRef("  slack  ")).toBe(
      "https://github.com/okou-ai/vm0-skills/tree/main/slack",
    );
  });

  it("returns full tree URL as-is", () => {
    const url = "https://github.com/acme/repo/tree/main/tool";
    expect(resolveSkillRef(url)).toBe(url);
  });

  it("preserves stored legacy registry URLs", () => {
    const url = "https://github.com/vm0-ai/vm0-skills/tree/main/slack";
    expect(resolveSkillRef(url)).toBe(url);
  });

  it("normalizes plain repo URL to tree URL with default branch", () => {
    expect(resolveSkillRef("https://github.com/acme/my-skill")).toBe(
      "https://github.com/acme/my-skill/tree/main",
    );
  });

  it("keeps tree URL without path as-is", () => {
    const url = "https://github.com/acme/repo/tree/develop";
    expect(resolveSkillRef(url)).toBe(url);
  });

  it("throws on empty string", () => {
    expect(() => {
      return resolveSkillRef("");
    }).toThrow("Skill reference cannot be empty");
  });

  it("throws on whitespace-only string", () => {
    expect(() => {
      return resolveSkillRef("   ");
    }).toThrow("Skill reference cannot be empty");
  });

  it("throws on non-GitHub URL", () => {
    expect(() => {
      return resolveSkillRef("https://example.com/foo");
    }).toThrow("Invalid skill URL");
  });

  it("throws on GitHub blob URL", () => {
    expect(() => {
      return resolveSkillRef("https://github.com/owner/repo/blob/main/file.ts");
    }).toThrow("Invalid skill URL");
  });
});
