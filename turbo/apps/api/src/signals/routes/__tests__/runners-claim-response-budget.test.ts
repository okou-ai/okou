import { CLAIM_RESPONSE_BUDGET_EXCEEDED_ERROR_CODE } from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const api = createRunsApi(context);

describe("Runner claim response capacity", () => {
  it("keeps an oversized claim queued and accepts the complete Unicode body at fitting capacity", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const instructions = "😀中文".repeat(16 * 1024);
      await createBddApi(context).updateAgentInstructions(
        owned.actor,
        owned.agentId,
        instructions,
      );
      const queued = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "fit the complete claim response",
        model: "auto",
      });
      const refused = await api.requestClaimRunnerJob(
        true,
        queued.runId,
        [409],
        {
          capabilities: {
            piModelConfigGenerations: [2, 3, 5],
            maxClaimResponseBytes: 1,
          },
        },
      );
      expect(refused.body.error.code).toBe(
        CLAIM_RESPONSE_BUDGET_EXCEEDED_ERROR_CODE,
      );
      expect(refused.body.requiredClaimResponseBytes).toBeGreaterThan(
        Buffer.byteLength(instructions),
      );
      await expect(
        api.readRun(owned.actor, queued.runId),
      ).resolves.toMatchObject({ status: "pending" });

      const claim = await owned.claimRunnerRun(queued.runId, {
        capabilities: {
          piModelConfigGenerations: [2, 3, 5],
          maxClaimResponseBytes: refused.body.requiredClaimResponseBytes,
        },
      });
      expect(claim.runId).toBe(queued.runId);
      expect(claim.agentInstructions).toBe(instructions);
      expect(Buffer.byteLength(JSON.stringify(claim))).toBe(
        refused.body.requiredClaimResponseBytes,
      );
      await expect(
        api.readRun(owned.actor, queued.runId),
      ).resolves.toMatchObject({ status: "running" });
    });
  });

  it("refuses an invalid capacity before claim and preserves the previous omitted-capability request", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const queued = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "validate capacity before accepting the job",
        model: "auto",
      });
      await api.requestClaimRunnerJob(true, queued.runId, [400], {
        capabilities: {
          piModelConfigGenerations: [2, 3, 5],
          maxClaimResponseBytes: 0,
        },
      });
      await expect(
        api.readRun(owned.actor, queued.runId),
      ).resolves.toMatchObject({ status: "pending" });
      const claim = await owned.claimRunnerRun(queued.runId);
      expect(claim.runId).toBe(queued.runId);
      await expect(
        api.readRun(owned.actor, queued.runId),
      ).resolves.toMatchObject({ status: "running" });
    });
  });
});
