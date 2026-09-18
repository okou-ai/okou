import { randomUUID } from "node:crypto";

import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  holdProductionUsageEventCompactionLockFixture,
  holdUsageEventCompactionLockFixture,
  withUsageEventCompactionScopeFixture,
} from "../../../test-fixtures/usage-event-compaction";
import { createBddApi } from "./helpers/api-bdd";

const context = testContext();
const bdd = createBddApi(context);

function ownGate(gate: {
  readonly release: () => void;
  readonly done: Promise<void>;
}) {
  const completion = Promise.allSettled([gate.done]);
  onTestFinished(async () => {
    gate.release();
    const [result] = await completion;
    if (result.status === "rejected") {
      throw result.reason;
    }
  });
}

async function createAgent() {
  bdd.acceptAgentStorageWrites();
  const actor = bdd.user();
  const agent = await bdd.createAgent(actor, {
    displayName: "Compaction admission isolation",
  });
  return { actor, agentId: agent.agentId };
}

describe("Agent deletion compaction admission ownership", () => {
  it("preserves a retryable conflict within the same test scope", async () => {
    const { actor, agentId } = await createAgent();
    const gate = await holdUsageEventCompactionLockFixture(context.signal);
    ownGate(gate);

    const response = await bdd.requestDeleteAgent(actor, agentId, [409]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Cannot delete agent right now; retry shortly",
        code: "CONFLICT",
      },
    });
    await bdd.requestReadAgent(actor, agentId, [200]);
    gate.release();
    await gate.done;
    await bdd.deleteAgent(actor, agentId);
    await bdd.requestReadAgent(actor, agentId, [404]);
  });

  it("deletes an owned Agent while another test scope holds compaction admission", async () => {
    const { actor, agentId } = await createAgent();
    // Infrastructure exception: a second test worker cannot be controlled
    // through HTTP. Hold its real PostgreSQL lock until deletion completes.
    const gate = await withUsageEventCompactionScopeFixture(
      randomUUID(),
      async () => {
        return await holdUsageEventCompactionLockFixture(context.signal);
      },
    );
    ownGate(gate);

    const response = await bdd.requestDeleteAgent(actor, agentId, [204]);

    expect(response.status).toBe(204);
    await bdd.requestReadAgent(actor, agentId, [404]);
    gate.release();
    await gate.done;
  });

  it("retains the production lock key and restores the enclosing test scope", async () => {
    const { actor, agentId } = await createAgent();
    const gate = await holdProductionUsageEventCompactionLockFixture(
      context.signal,
    );
    ownGate(gate);

    const response = await withUsageEventCompactionScopeFixture(
      undefined,
      async () => {
        return await bdd.requestDeleteAgent(actor, agentId, [409]);
      },
    );

    expect(response.body).toMatchObject({
      error: { code: "CONFLICT" },
    });
    await bdd.requestReadAgent(actor, agentId, [200]);
    // The global holder stays locked: this succeeds only if shared setup
    // installed a scope and the explicit production call restored it.
    await bdd.deleteAgent(actor, agentId);
    await bdd.requestReadAgent(actor, agentId, [404]);
    gate.release();
    await gate.done;
  });
});
