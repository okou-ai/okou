import { describe, expect, it, vi } from "vitest";

import { isPersonalExecution } from "../personal-execution";

function runToken(singleAgent?: true): string {
  const payload = Buffer.from(
    JSON.stringify({
      scope: "okou",
      userId: "current-member",
      orgId: "current-org",
      runId: "current-run",
      capabilities: [],
      ...(singleAgent === true ? { singleAgent } : {}),
    }),
  ).toString("base64url");
  return `vm0_sandbox_header.${payload}.signature`;
}

describe("My Okou CLI context", () => {
  it.each([true, undefined] as const)(
    "follows the signed Run marker %s",
    (captured) => {
      vi.stubEnv("OKOU_TOKEN", runToken(captured));
      expect(isPersonalExecution()).toBe(captured === true);
    },
  );

  it("uses My Okou for standalone commands", () => {
    vi.stubEnv("OKOU_TOKEN", "current-cli-token");
    expect(isPersonalExecution()).toBe(true);
  });
});
