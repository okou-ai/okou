import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import {
  peerContinuation,
  peerFinalizingFixture,
  peerHeartbeat,
  peerPoll,
} from "./helpers/peer-finalizing-fixture";

const context = testContext();

describe("peer finalizing eligibility", () => {
  it.each<
    readonly [
      string,
      "source" | "receiver",
      NonNullable<Parameters<typeof peerHeartbeat>[2]>,
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
  ])("rejects %s", async (_label, role, changes) => {
    const f = await peerFinalizingFixture(context);
    await peerHeartbeat(
      f,
      role === "source" ? f.sourceId : f.receiverId,
      changes,
    );
    const next = await peerContinuation(f);
    await expect(peerPoll(f)).resolves.toMatchObject({
      runId: next.runId,
      runnerPreference: { kind: "noPreference" },
    });
  });
});
