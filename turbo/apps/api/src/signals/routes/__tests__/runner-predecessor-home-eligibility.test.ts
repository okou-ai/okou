import { describe, expect, it } from "vitest";
import { mockNow } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-context";
import {
  predecessorHomeContinuation,
  predecessorHomeFixture,
  predecessorHomeHeartbeat,
  predecessorHomePoll,
} from "./helpers/predecessor-home-fixture";

const context = testContext();

describe("predecessor Home recipient eligibility", () => {
  it.each<
    readonly [
      string,
      "source" | "receiver",
      NonNullable<Parameters<typeof predecessorHomeHeartbeat>[2]>,
    ]
  >([
    [
      "source hostname mismatch",
      "source",
      { runnerHostname: "wrong.example.test" },
    ],
    ["source hostname omission", "source", { runnerHostname: undefined }],
    ["source group mismatch", "source", { group: "vm0/unrelated-peer-test" }],
    ["source generation restart", "source", { snapshotGeneration: 8 }],
    [
      "receiver hostname mismatch",
      "receiver",
      { runnerHostname: "wrong.example.test" },
    ],
    ["receiver hostname omission", "receiver", { runnerHostname: undefined }],
    [
      "receiver group mismatch",
      "receiver",
      { group: "vm0/unrelated-peer-test" },
    ],
    ["receiver full capacity", "receiver", { admittableProfiles: [] }],
    [
      "receiver wrong profile",
      "receiver",
      { admittableProfiles: ["vm0/other"] },
    ],
    ["receiver starting", "receiver", { mode: "starting" }],
    ["receiver draining", "receiver", { mode: "draining" }],
  ])(
    "does not infer finalizing ownership from %s",
    async (_label, role, changes) => {
      const f = await predecessorHomeFixture(context);
      await predecessorHomeHeartbeat(
        f,
        role === "source" ? f.predecessorRunnerId : f.receiverRunnerId,
        changes,
      );
      mockNow(f.clock + 2000);
      const next = await predecessorHomeContinuation(f);
      await expect(predecessorHomePoll(f)).resolves.toMatchObject({
        runId: next.runId,
        runnerPreference:
          role === "source"
            ? {
                kind: "preference",
                tier: "predecessorHome",
                home: { evidence: "location" },
                predecessorRunId: f.predecessorRun.runId,
              }
            : { kind: "noPreference" },
      });
    },
  );
});
