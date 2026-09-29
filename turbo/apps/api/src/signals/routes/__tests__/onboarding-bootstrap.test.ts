import { randomUUID } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  agentInstructionsContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import { SEED_INSTRUCTIONS } from "@okouai/core/seed-instructions";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { agentInstructionsRoutes } from "../agent-instructions";
import { agentsRoutes } from "../agents";
import { billingStatusRoutes } from "../billing-status";
import { onboardingStatusRoutes } from "../onboarding-status";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function clients() {
  const app = setupApp({
    context,
    routes: [
      ...onboardingStatusRoutes,
      ...agentsRoutes,
      ...agentInstructionsRoutes,
      ...billingStatusRoutes,
    ],
  });
  return {
    status: app(onboardingStatusContract),
    agents: app(agentsMainContract),
    instructions: app(agentInstructionsContract),
    billing: app(billingStatusContract),
  };
}

function authenticateAdmin(): string {
  const orgId = `org_${randomUUID()}`;
  mocks.clerk.session(`user_${randomUUID()}`, orgId, "org:admin");
  return orgId;
}

describe("default Agent bootstrap", () => {
  it("publishes one usable default and one grant for concurrent status requests", async () => {
    const orgId = authenticateAdmin();
    installDurableUserExportStorage(context, { prefixes: [`${orgId}/`] });
    const api = clients();
    const responses = await Promise.all([
      accept(api.status.getStatus({ headers }), [200]),
      accept(api.status.getStatus({ headers }), [200]),
      accept(api.status.getStatus({ headers }), [200]),
    ]);
    const agentId = responses[0]?.body.defaultAgentId;
    if (!agentId) {
      throw new Error("Expected a usable default Agent");
    }
    for (const response of responses) {
      expect(response.body).toMatchObject({
        hasDefaultAgent: true,
        defaultAgentId: agentId,
      });
    }
    const listed = await accept(api.agents.list({ headers }), [200]);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]?.agentId).toBe(agentId);
    const instructions = await accept(
      api.instructions.get({ headers, params: { id: agentId } }),
      [200],
    );
    expect(instructions.body.content).toBe(SEED_INSTRUCTIONS);

    const edited = "Keep the workspace's edited instructions.";
    await accept(
      api.instructions.update({
        headers,
        params: { id: agentId },
        body: { content: edited },
      }),
      [200],
    );
    await accept(api.status.getStatus({ headers }), [200]);
    const after = await accept(
      api.instructions.get({ headers, params: { id: agentId } }),
      [200],
    );
    expect(after.body.content).toBe(edited);
    const billing = await accept(api.billing.get({ headers }), [200]);
    expect(billing.body.credits).toBe(1000);
    expect(billing.body.creditGrants).toStrictEqual([
      expect.objectContaining({
        source: "onboarding",
        amount: 1000,
        remaining: 1000,
      }),
    ]);
  });

  it("recovers a usable default after an upload fails without granting twice", async () => {
    const orgId = authenticateAdmin();
    let rejectArchiveUpload = true;
    installDurableUserExportStorage(context, {
      prefixes: [`${orgId}/`],
      afterWrite: (command) => {
        if (
          rejectArchiveUpload &&
          command instanceof PutObjectCommand &&
          command.input.Key?.endsWith("/archive.tar.gz")
        ) {
          rejectArchiveUpload = false;
          // Model an object store that persisted the bytes before the response
          // failed, so bootstrap must compensate even though its row rolls back.
          return Promise.reject(
            new Error("Object store upload response failed"),
          );
        }
        return Promise.resolve();
      },
    });
    const api = clients();
    const failed = await accept(api.status.getStatus({ headers }), [200]);
    expect(failed.body).toMatchObject({
      hasDefaultAgent: false,
      defaultAgentId: null,
    });
    const beforeRetry = await accept(api.agents.list({ headers }), [200]);
    expect(beforeRetry.body).toStrictEqual([]);
    // Credits have their own atomic lifetime. Failed remote preparation must
    // neither publish a partial Agent nor duplicate this committed grant.
    const grantedBeforeRetry = await accept(
      api.billing.get({ headers }),
      [200],
    );
    expect(grantedBeforeRetry.body.credits).toBe(1000);
    expect(grantedBeforeRetry.body.creditGrants).toStrictEqual([
      expect.objectContaining({
        source: "onboarding",
        amount: 1000,
        remaining: 1000,
      }),
    ]);

    const retries = await Promise.all([
      accept(api.status.getStatus({ headers }), [200]),
      accept(api.status.getStatus({ headers }), [200]),
    ]);
    const agentId = retries[0]?.body.defaultAgentId;
    if (!agentId) {
      throw new Error("Expected bootstrap retry to publish a default Agent");
    }
    for (const retry of retries) {
      expect(retry.body.defaultAgentId).toBe(agentId);
    }
    const instructions = await accept(
      api.instructions.get({ headers, params: { id: agentId } }),
      [200],
    );
    expect(instructions.body.content).toBe(SEED_INSTRUCTIONS);
    const billing = await accept(api.billing.get({ headers }), [200]);
    expect(billing.body.credits).toBe(1000);
    expect(billing.body.creditGrants).toHaveLength(1);
  });
});
