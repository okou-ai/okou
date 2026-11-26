import { randomUUID } from "node:crypto";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { expect, test } from "vitest";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = { authorization: "Bearer clerk-session" };
const app = setupApp({
  context,
  routes: [...workflowsRoutes, ...workflowAutomationsRoutes],
});

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "org:admin" | "org:member";
}

function as(actor: Actor) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.role,
  );
  return headers;
}

async function schedule(actor: Actor, workflowId: string, seconds: number) {
  await accept(
    app(workflowAutomationsContract).create({
      headers: as(actor),
      params: { workflowId },
      body: { schedule: { type: "loop", intervalSeconds: seconds } },
    }),
    [201],
  );
}

test("workspace-workflow-permissions-002 copies only the caller's Automations", async () => {
  const orgId = `org_${randomUUID()}`;
  const admin: Actor = {
    userId: `user_${randomUUID()}`,
    orgId,
    role: "org:admin",
  };
  const member: Actor = {
    userId: `user_${randomUUID()}`,
    orgId,
    role: "org:member",
  };
  const source = await accept(
    app(workflowsCollectionContract).create({
      headers: as(admin),
      body: {
        name: `shared-${randomUUID().slice(0, 8)}`,
        visibility: "public",
      },
    }),
    [201],
  );
  await schedule(admin, source.body.id, 1800);
  await schedule(member, source.body.id, 900);

  const copy = await accept(
    app(workflowsDetailContract).copy({
      headers: as(member),
      params: { workflowId: source.body.id },
      body: {},
    }),
    [201],
  );
  const automations = await accept(
    app(workflowAutomationsContract).list({
      headers: as(member),
      params: { workflowId: copy.body.id },
    }),
    [200],
  );

  expect(automations.body).toHaveLength(1);
  expect(automations.body[0]).toMatchObject({
    ownerUserId: member.userId,
    kind: "schedule",
    schedule: { type: "loop", intervalSeconds: 900 },
  });
});
