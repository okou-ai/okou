import { describe, expect, it } from "vitest";
import { createWorkflowTokenMatcher } from "../workflow-slash-token";

describe("ordinary workflow slash tokens", () => {
  it.each([
    ["/daily-digest", true],
    ["Please use /daily-digest\nnext", true],
    ["/daily-digest /other", true],
    ["/Daily-Digest", false],
    ["/daily-digest-extra", false],
    ["/daily-digest,", false],
    ["https://example.test/daily-digest", false],
  ])("matches only a complete case-sensitive token in %s", (text, matches) => {
    expect(
      Boolean(createWorkflowTokenMatcher(["daily-digest"])?.(text).length),
    ).toBe(matches);
  });

  it("matches names literally and supports multiple workflow names", () => {
    const matchTokens = createWorkflowTokenMatcher(["a.b", "other"]);
    expect(matchTokens?.("/a.b /other")).toStrictEqual([
      { name: "a.b", from: 0, to: 4 },
      { name: "other", from: 5, to: 11 },
    ]);
    expect(matchTokens?.("/axb")).toStrictEqual([]);
    expect(createWorkflowTokenMatcher([])).toBeNull();
  });

  it("retains each repeated token's exact range after whitespace", () => {
    const matchTokens = createWorkflowTokenMatcher(["run"]);
    expect(matchTokens?.("\t/run\n/run /unknown")).toStrictEqual([
      { name: "run", from: 1, to: 5 },
      { name: "run", from: 6, to: 10 },
    ]);
  });
});
