import { randomUUID } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  agentsMainContract,
  agentInstructionsContract,
} from "@okouai/api-contracts/contracts/agents";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { onTestFinished } from "vitest";
import { Webhook } from "svix";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { agentsRoutes } from "../agents";
import { agentInstructionsRoutes } from "../agent-instructions";
import { workflowsRoutes } from "../workflows";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createRouteMocks } from "./helpers/route-test";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function actor(orgId = `org_${randomUUID()}`) {
  return { orgId, userId: `user_${randomUUID()}` };
}

function authenticate(user: ReturnType<typeof actor>) {
  createRouteMocks(context).clerk.session(user.userId, user.orgId, "org:admin");
}

async function createAgent(user: ReturnType<typeof actor>) {
  authenticate(user);
  const response = await accept(
    setupApp({ context, routes: agentsRoutes })(agentsMainContract).create({
      headers,
      body: { displayName: "Publication cleanup", visibility: "public" },
    }),
    [201],
  );
  return response.body.agentId;
}

function workflowClient(user: ReturnType<typeof actor>) {
  authenticate(user);
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}

async function createWorkflow(
  user: ReturnType<typeof actor>,
  agentId: string,
  visibility: "public" | "private",
) {
  authenticate(user);
  const response = await accept(
    setupApp({ context, routes: workflowsRoutes })(
      workflowsCollectionContract,
    ).create({
      headers,
      body: {
        agentId,
        visibility,
        name: `cleanup-${randomUUID()}`,
        instruction: "Original instructions",
      },
    }),
    [201],
  );
  return response.body.id;
}

function uploadPause() {
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  const finish = () => {
    if (!release.settled()) {
      release.resolve();
    }
  };
  onTestFinished(finish);
  return {
    entered: entered.promise,
    release: finish,
    async wait() {
      entered.resolve();
      await release.promise;
    },
  };
}

async function deleteAuthority(
  kind: "user" | "organization",
  user: ReturnType<typeof actor>,
) {
  const secret = `whsec_${Buffer.from("publication-cleanup-signing-key").toString("base64")}`;
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", secret);
  context.mocks.clerk.verifyWebhook.mockImplementation(async (request) => {
    if (!(request instanceof Request)) {
      throw new Error("Expected the Clerk webhook request");
    }
    const payload = await request.text();
    new Webhook(secret).verify(payload, Object.fromEntries(request.headers));
    const event: unknown = JSON.parse(payload);
    return event;
  });
  const body = JSON.stringify({
    type: kind === "user" ? "user.deleted" : "organization.deleted",
    data: { id: kind === "user" ? user.userId : user.orgId },
  });
  const id = `msg_${randomUUID()}`;
  const timestamp = nowDate();
  const response = await accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({
      body,
      extraHeaders: {
        "svix-id": id,
        "svix-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
        "svix-signature": new Webhook(secret).sign(id, timestamp, body),
      },
    }),
    [200],
  );
  expect(response.body).toBe("OK");
  await flushWaitUntilForTest();
}

test("rejects an erased user's pending private publication while peer and agent-wide publications finish", async () => {
  const peer = actor();
  const removed = actor(peer.orgId);
  const unrelated = actor();
  const pauses: ReturnType<typeof uploadPause>[] = [];
  installDurableUserExportStorage(context, {
    prefixes: ["org_"],
    afterWrite: async (command) => {
      if (
        command instanceof PutObjectCommand &&
        command.input.Key?.endsWith("/archive.tar.gz")
      ) {
        await pauses.shift()?.wait();
      }
    },
  });
  const agentId = await createAgent(peer);
  const removedWorkflow = await createWorkflow(removed, agentId, "private");
  const peerWorkflow = await createWorkflow(peer, agentId, "private");
  const publicWorkflow = await createWorkflow(peer, agentId, "public");
  const unrelatedAgent = await createAgent(unrelated);
  const unrelatedWorkflow = await createWorkflow(
    unrelated,
    unrelatedAgent,
    "private",
  );
  const pending: Promise<unknown>[] = [];
  const gates: ReturnType<typeof uploadPause>[] = [];
  onTestFinished(async () => {
    for (const gate of gates) {
      gate.release();
    }
    await Promise.allSettled(pending);
  });
  for (const [user, workflowId] of [
    [removed, removedWorkflow],
    [peer, peerWorkflow],
    [peer, publicWorkflow],
  ] as const) {
    const gate = uploadPause();
    gates.push(gate);
    pauses.push(gate);
    pending.push(
      settleIncludingAbort(
        workflowClient(user).update({
          headers,
          params: { workflowId },
          body: { instruction: "Pending publication" },
        }),
      ),
    );
    await gate.entered;
  }
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    { data: [{ publicUserData: { userId: peer.userId } }] },
  );
  await deleteAuthority("user", removed);
  for (const gate of gates) {
    gate.release();
  }
  const responses = await Promise.all(pending);
  expect(responses).toMatchObject([
    { ok: true, value: { status: 409 } },
    { ok: true, value: { status: 200 } },
    { ok: true, value: { status: 200 } },
  ]);
  for (const workflowId of [peerWorkflow, publicWorkflow]) {
    const response = await accept(
      workflowClient(peer).get({ headers, params: { workflowId } }),
      [200],
    );
    expect(response.body.instruction).toBe("Pending publication");
  }
  await accept(
    workflowClient(unrelated).update({
      headers,
      params: { workflowId: unrelatedWorkflow },
      body: { instruction: "Surviving organization" },
    }),
    [200],
  );
  const survivor = await accept(
    workflowClient(unrelated).get({
      headers,
      params: { workflowId: unrelatedWorkflow },
    }),
    [200],
  );
  expect(survivor.body.instruction).toBe("Surviving organization");
});

test("rejects a late instruction publication after signed organization deletion and preserves another organization", async () => {
  const removed = actor();
  const survivor = actor();
  const gate = uploadPause();
  let blocked = false;
  installDurableUserExportStorage(context, {
    prefixes: ["org_"],
    afterWrite: async (command) => {
      if (
        blocked &&
        command instanceof PutObjectCommand &&
        command.input.Key?.endsWith("/archive.tar.gz")
      ) {
        blocked = false;
        await gate.wait();
      }
    },
  });
  const removedAgent = await createAgent(removed);
  const survivorAgent = await createAgent(survivor);
  function instructions(user: ReturnType<typeof actor>) {
    authenticate(user);
    return setupApp({ context, routes: agentInstructionsRoutes })(
      agentInstructionsContract,
    );
  }
  blocked = true;
  const pending = instructions(removed).update({
    headers,
    params: { id: removedAgent },
    body: { content: "Deleted instructions" },
  });
  onTestFinished(async () => {
    gate.release();
    await Promise.allSettled([pending]);
  });
  await gate.entered;
  await deleteAuthority("organization", removed);
  gate.release();
  await accept(pending, [404]);
  await accept(
    instructions(survivor).update({
      headers,
      params: { id: survivorAgent },
      body: { content: "Surviving instructions" },
    }),
    [200],
  );
  const response = await accept(
    instructions(survivor).get({ headers, params: { id: survivorAgent } }),
    [200],
  );
  expect(response.body.content).toBe("Surviving instructions");
});
