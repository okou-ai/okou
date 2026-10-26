import { describe, expect, it } from "vitest";
import { fromJSONSchema } from "zod";
import { computerUseSessionHostsContract } from "../../contracts/computer-use";
import { desktopResponseTransforms } from "../desktop";
import { selectClientResponseTransforms } from "../select";
import { previousCommandClaimJsonSchema } from "./fixtures/desktop-command-claim-0.52.2";

// Exact 200 schema from runtime-api-schema-prod/current.json, published 2026-10-15.
const previous = fromJSONSchema(previousCommandClaimJsonSchema);
const claim = {
  status: "command",
  command: {
    id: "operation",
    kind: "shell.cmd",
    status: "running",
    hostId: "host",
    hostName: "Mac",
    payload: {},
    timeoutMs: 25_000,
    createdAt: "2026-10-15T00:00:00Z",
    claimedAt: "2026-10-15T00:00:01Z",
    completedAt: null,
  },
};
const select = (version: string) => {
  return selectClientResponseTransforms({
    transforms: desktopResponseTransforms,
    client: "Desktop",
    version,
    method: "POST",
    path: "/api/computer-use/hosts/:hostId/commands/next",
    status: 200,
  });
};

describe("Pre-Shell Desktop claim compatibility", () => {
  it("documents widened output and fails closed if a Shell claim leaks to an old build", () => {
    expect(
      computerUseSessionHostsContract.next.responses[200].safeParse(claim)
        .success,
    ).toBe(true);
    expect(previous.safeParse(claim).success).toBe(false);
    expect(() => {
      return select("0.52.2")[0]?.transform(claim);
    }).toThrow("Shell claims require");
  });
  it("preserves GUI claims and idle responses in the installed decoder's shape", () => {
    const gui = { ...claim, command: { ...claim.command, kind: "apps.list" } };
    expect(previous.parse(select("0.52.2")[0]?.transform(gui))).toStrictEqual(
      gui,
    );
    expect(
      previous.parse(select("0.53.4")[0]?.transform({ status: "idle" })),
    ).toStrictEqual({ status: "idle" });
    expect(select("0.54.0")).toStrictEqual([]);
  });
});
