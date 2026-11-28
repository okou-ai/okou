import { randomUUID } from "node:crypto";
import {
  personalModelProvidersByTypeContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { createStore } from "ccstate";
import { expect, test } from "vitest";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { runModelsRoutes } from "../run-models";
import { workflowsRoutes } from "../workflows";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface Member {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "admin" | "member";
}

async function workspaceMember(
  role: "admin" | "member",
  orgId = `org_${randomUUID()}`,
): Promise<Member> {
  const member: Member = { userId: `user_${randomUUID()}`, orgId, role };
  await createStore().set(seedOrgMembership$, member, context.signal);
  return member;
}

function signIn(member: Member) {
  createRouteMocks(context).clerk.session(
    member.userId,
    member.orgId,
    member.role === "admin" ? "org:admin" : "org:member",
  );
}

test("misc-routes.bdd-006 creates, replaces and deletes a personal subscription", async () => {
  const providers = setupApp({
    context,
    routes: [...meModelProvidersListRoutes, ...meModelProvidersUpsertRoutes],
  })(personalModelProvidersMainContract);
  const byType = setupApp({ context, routes: meModelProvidersDeleteRoutes })(
    personalModelProvidersByTypeContract,
  );
  const runModels = setupApp({ context, routes: runModelsRoutes })(
    runModelsMainContract,
  );
  const listProviders = async () => {
    return (await accept(providers.list({ headers }), [200])).body
      .modelProviders;
  };
  const listRunModels = async () => {
    return (await accept(runModels.list({ headers }), [200])).body.models;
  };

  const anonymous = await accept(providers.list({ headers: {} }), [401]);
  const admin = await workspaceMember("admin");
  signIn(admin);
  mockClaudeCodeTokenEndpoint();
  const initial = await listProviders();
  const first = await accept(
    providers.upsert({
      headers,
      body: { type: "claude-code-oauth-token", secret: "first-claude-token" },
    }),
    [201],
  );
  const modelsWithSubscription = await listRunModels();
  mockClaudeCodeTokenEndpoint({ accountEmail: "replacement@example.com" });
  const replacement = await accept(
    providers.upsert({
      headers,
      body: { type: "claude-code-oauth-token", secret: "second-claude-token" },
    }),
    [201],
  );
  const afterReplacement = await listProviders();
  await accept(
    byType.delete({
      headers,
      params: { type: "claude-code-oauth-token" },
    }),
    [204],
  );
  const afterDelete = await listProviders();
  const modelsAfterDelete = await listRunModels();

  expect(anonymous.body).toMatchObject({ error: expect.any(Object) });
  expect(initial).toStrictEqual([]);
  expect(first.body.created).toBeTruthy();
  expect(first.body.provider.isActive).toBeTruthy();
  expect(first.body.provider.modelProviderId).toStrictEqual(expect.any(String));
  expect(first.body.provider).not.toHaveProperty("secret");
  expect(modelsWithSubscription).toContainEqual(
    expect.objectContaining({
      model: "claude-sonnet-5-5",
      memberEffective: expect.objectContaining({
        runtimeProviderType: "claude-code-oauth-token",
        credentialScope: "member",
      }),
    }),
  );
  expect(replacement.body.provider.modelProviderId).toBe(
    first.body.provider.modelProviderId,
  );
  expect(replacement.body.provider.id).not.toBe(first.body.provider.id);
  expect(afterReplacement).toHaveLength(1);
  expect(afterReplacement[0]).toMatchObject({
    id: replacement.body.provider.id,
    isActive: true,
  });
  expect(afterDelete).toStrictEqual([]);
  expect(
    modelsAfterDelete.map((model) => {
      return model.model;
    }),
  ).toStrictEqual(["auto"]);
});

test("misc-routes.bdd-004 runs a workflow through create, read, update and delete", async () => {
  installWorkflowVolumeS3Fixture(context);
  const admin = await workspaceMember("admin");
  const member = await workspaceMember("member", admin.orgId);
  const collection = setupApp({ context, routes: workflowsRoutes })(
    workflowsCollectionContract,
  );
  const detail = setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );

  signIn(member);
  const memberWorkflow = await accept(
    collection.create({
      headers,
      body: {
        name: `member-${randomUUID().slice(0, 8)}`,
        instruction: "Member instruction",
      },
    }),
    [201],
  );

  signIn(admin);
  const initialList = await accept(collection.list({ headers }), [200]);
  const reserved = await accept(
    collection.create({
      headers,
      body: {
        name: `reserved-${randomUUID().slice(0, 8)}`,
        instruction: "Reserved file",
        files: [{ path: "SKILL.md", content: "reserved" }],
      },
    }),
    [400],
  );
  const created = await accept(
    collection.create({
      headers,
      body: {
        name: `bdd-${randomUUID().slice(0, 8)}`,
        displayName: "BDD Workflow",
        description: "Workflow created through the public API",
        instruction: "Original instruction",
      },
    }),
    [201],
  );
  const workflowId = created.body.id;
  const list = await accept(collection.list({ headers }), [200]);
  const read = await accept(
    detail.get({ headers, params: { workflowId } }),
    [200],
  );
  const updated = await accept(
    detail.update({
      headers,
      params: { workflowId },
      body: { instruction: "Updated instruction" },
    }),
    [200],
  );
  await accept(
    detail.delete({ headers, params: { workflowId }, body: undefined }),
    [204],
  );
  const afterDelete = await accept(
    detail.get({ headers, params: { workflowId } }),
    [404],
  );

  expect(memberWorkflow.body).toMatchObject({
    visibility: "private",
    ownerUserId: member.userId,
    canManage: true,
  });
  expect(
    initialList.body.map((workflow) => {
      return workflow.id;
    }),
  ).not.toContain(memberWorkflow.body.id);
  expect(reserved.body).toMatchObject({ error: expect.any(Object) });
  expect(created.body).toMatchObject({
    displayName: "BDD Workflow",
    description: "Workflow created through the public API",
  });
  expect(
    list.body.map((workflow) => {
      return workflow.id;
    }),
  ).toContain(workflowId);
  expect(read.body.instruction).toBe("Original instruction");
  expect(updated.body.instruction).toBe("Updated instruction");
  expect(afterDelete.body).toMatchObject({ error: expect.any(Object) });
});
