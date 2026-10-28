import { describe, expect, it } from "vitest";
import { mockNow } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-context";
import {
  sourceHomeContinuation,
  sourceHomeFixture,
  sourceHomeHeartbeat,
  sourceHomePoll,
} from "./helpers/source-home-fixture";

const context = testContext();

describe("source Home recipient eligibility", () => {
  it.each<
    readonly [
      string,
      "source" | "receiver",
      NonNullable<Parameters<typeof sourceHomeHeartbeat>[2]>,
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
      const f = await sourceHomeFixture(context);
      await sourceHomeHeartbeat(
        f,
        role === "source" ? f.sourceId : f.receiverId,
        changes,
      );
      mockNow(f.clock + 2000);
      const next = await sourceHomeContinuation(f);
      await expect(sourceHomePoll(f)).resolves.toMatchObject({
        runId: next.runId,
        runnerPreference:
          role === "source"
            ? {
                kind: "preference",
                tier: "sourceHome",
                home: { evidence: "location" },
                sourceRunId: f.source.runId,
              }
            : { kind: "noPreference" },
      });
    },
  );
});
