import { randomUUID } from "node:crypto";
import { aroundEach, describe, expect, it } from "vitest";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cronExecuteWorkflowAutomationsContract } from "@okouai/api-contracts/contracts/cron";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockNow, now, withNowScopeForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const wf = createWorkflowsBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const mocks = createRouteMocks(context);

aroundEach(async (runTest) => {
  await withNowScopeForTest(runTest);
});

function headers(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function collectionClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsCollectionContract,
  );
}

function detailClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

async function composer(actor: ApiTestUser, agentId: string) {
  const response = await accept(
    collectionClient().composer({
      headers: headers(actor),
      query: { agentId },
    }),
    [200],
  );
  return response.body;
}

const BINGJIE_USER_ID = "user_3EWY21Oe3f15kfs3yYmbGgDb3NV";

async function setup(tier: "pro" | "team" = "pro", enabled = true) {
  await runs.configureRunnerGroup();
  const actor = wf.user(enabled ? { userId: BINGJIE_USER_ID } : {});
  await runs.grantProEntitlement(actor, { tier });
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const { agentId } = await wf.createAgent(actor);
  return { actor, agentId };
}

function acceptedTime(body: { readonly createdAt?: string }): string {
  if (!body.createdAt) {
    throw new Error("Expected the accepted input timestamp");
  }
  return body.createdAt;
}

function recencyTime(value: string | number): string {
  return new Date(value).toISOString().replace(/Z$/, "000Z");
}

async function createWorkflow(
  actor: ApiTestUser,
  agentId: string,
  name: string,
  visibility: "public" | "private" = "public",
) {
  return await wf.createWorkflow(actor, { agentId, name, visibility });
}

describe("server-owned workflow recency", () => {
  it("keeps default-off sessions on the baseline without recording slash, manual or Run now usage", async () => {
    const { actor, agentId } = await setup("pro", false);
    const workflowId = await createWorkflow(actor, agentId, "recency-disabled");
    const automation = await accept(
      automationsClient().create({
        headers: headers(actor),
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 3600 } },
      }),
      [201],
    );
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();
    await chat.requestSendEvent(
      actor,
      { agentId, prompt: "/recency-disabled" },
      [201],
    );
    await accept(
      detailClient().run({ headers: headers(actor), params: { workflowId } }),
      [200],
    );
    await accept(
      automationsClient().run({
        headers: headers(actor),
        params: { id: automation.body.id },
      }),
      [201],
    );
    await accept(
      collectionClient().migrateRecency({
        headers: headers(actor),
        body: { workflowIds: [workflowId] },
      }),
      [403],
    );
    await expect(composer(actor, agentId)).resolves.toContainEqual(
      expect.objectContaining({ id: workflowId, lastUsedAt: null }),
    );
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      "userPreferenceChanged",
      { kinds: ["workflowRecency"] },
    );
  });

  it("hides stored recency when opted out and leaves it unchanged until opted back in", async () => {
    const { actor, agentId } = await setup();
    const workflowId = await createWorkflow(actor, agentId, "recency-opt-out");
    const ignoredId = await createWorkflow(actor, agentId, "recency-off-send");
    await accept(
      collectionClient().migrateRecency({
        headers: headers(actor),
        body: { workflowIds: [workflowId] },
      }),
      [200],
    );
    const before = await composer(actor, agentId);
    if (!actor.orgId) {
      throw new Error("Expected a workflow workspace");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.WorkflowRecency]: false },
    );
    await expect(composer(actor, agentId)).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: workflowId, lastUsedAt: null }),
        expect.objectContaining({ id: ignoredId, lastUsedAt: null }),
      ]),
    );
    await chat.requestSendEvent(
      actor,
      { agentId, prompt: "/recency-off-send" },
      [201],
    );
    await accept(
      collectionClient().migrateRecency({
        headers: headers(actor),
        body: { workflowIds: [ignoredId] },
      }),
      [403],
    );
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.WorkflowRecency]: true },
    );
    await expect(composer(actor, agentId)).resolves.toStrictEqual(before);
  });

  it("records accepted visible tokens and their private winner, preserving model preferences and replay time", async () => {
    const { actor, agentId } = await setup();
    const publicId = await createWorkflow(actor, agentId, "recency-alpha");
    const privateId = await createWorkflow(
      actor,
      agentId,
      "recency-alpha",
      "private",
    );
    const betaId = await createWorkflow(actor, agentId, "recency-beta");
    const ignoredId = await createWorkflow(actor, agentId, "recency-ignored");
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: randomUUID(),
        prompt: "/recency-ignored",
      },
      [404],
    );
    const clientEventId = randomUUID();
    const accepted = await chat.requestSendEvent(
      actor,
      {
        agentId,
        clientEventId,
        model: "claude-fable-5-1",
        prompt: "assembled prompt /recency-ignored",
        userMessage: {
          version: 1,
          parts: [
            { type: "additional_info", text: "/recency-ignored" },
            {
              type: "text",
              text: "/recency-alpha\n/recency-beta /recency-beta",
            },
          ],
        },
      },
      [201],
    );
    if (accepted.status !== 201) {
      throw new Error("Expected the workflow input to be accepted");
    }
    const acceptedAt = acceptedTime(accepted.body);
    const listed = await composer(actor, agentId);
    expect(listed).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: privateId,
          lastUsedAt: recencyTime(acceptedAt),
        }),
        expect.objectContaining({
          id: betaId,
          lastUsedAt: recencyTime(acceptedAt),
        }),
        expect.objectContaining({ id: ignoredId, lastUsedAt: null }),
      ]),
    );
    expect(
      listed.map((workflow) => {
        return workflow.id;
      }),
    ).not.toContain(publicId);
    const preferences = await accept(
      setupApp({ context, routes: userModelPreferenceRoutes })(
        userModelPreferenceContract,
      ).get({ headers: headers(actor) }),
      [200],
    );
    expect(preferences.body.selectedModel).toBe("claude-fable-5-1");

    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "userPreferenceChanged",
      { kinds: ["workflowRecency"] },
    );
    mockNow(Date.parse(acceptedAt) + 60_000);
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: accepted.body.threadId,
        clientEventId,
        prompt: "/recency-ignored",
      },
      [201],
    );
    await expect(composer(actor, agentId)).resolves.toStrictEqual(listed);
  });

  it("atomically retains concurrent uses, never regresses a timestamp, and keeps the deterministic top ten", async () => {
    const { actor, agentId } = await setup();
    const workflows = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const name = `recency-top-${index}`;
        return { id: await createWorkflow(actor, agentId, name), name };
      }),
    );
    const first = workflows[0];
    const second = workflows[1];
    if (!first || !second) {
      throw new Error("Expected workflow fixtures");
    }
    const latest = now();
    mockNow(latest);
    await Promise.all(
      [first, second].map(async (workflow) => {
        await chat.requestSendEvent(
          actor,
          { agentId, prompt: `/${workflow.name}` },
          [201],
        );
      }),
    );
    expect(
      (await composer(actor, agentId)).filter((workflow) => {
        return workflow.lastUsedAt === recencyTime(latest);
      }),
    ).toHaveLength(2);

    mockNow(latest - 60_000);
    const older = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: workflows
          .map((workflow) => {
            return `/${workflow.name}`;
          })
          .join(" "),
      },
      [201],
    );
    if (older.status !== 201) {
      throw new Error("Expected the older workflow input to be accepted");
    }
    const recent = (await composer(actor, agentId)).filter((workflow) => {
      return workflow.lastUsedAt !== null;
    });
    expect(recent).toHaveLength(10);
    expect(recent).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.id,
          lastUsedAt: recencyTime(latest),
        }),
        expect.objectContaining({
          id: second.id,
          lastUsedAt: recencyTime(latest),
        }),
      ]),
    );
    const remainingIds = workflows
      .slice(2)
      .map((workflow) => {
        return workflow.id;
      })
      .sort()
      .slice(0, 8);
    expect(
      recent
        .filter((workflow) => {
          return workflow.lastUsedAt === recencyTime(acceptedTime(older.body));
        })
        .map((workflow) => {
          return workflow.id;
        })
        .sort(),
    ).toStrictEqual(remainingIds);
  });

  it.each(["import-first", "send-first", "concurrent"] as const)(
    "preserves live accepted usage over legacy markers with %s ordering",
    async (ordering) => {
      const { actor, agentId } = await setup();
      const legacyId = await createWorkflow(
        actor,
        agentId,
        "recency-legacy-race",
      );
      const actualId = await createWorkflow(
        actor,
        agentId,
        "recency-actual-race",
      );
      const importHistory = () => {
        return accept(
          collectionClient().migrateRecency({
            headers: headers(actor),
            body: { workflowIds: [legacyId] },
          }),
          [200],
        );
      };
      const send = () => {
        return chat.requestSendEvent(
          actor,
          { agentId, prompt: "/recency-actual-race" },
          [201],
        );
      };
      async function requests() {
        if (ordering === "import-first") {
          return [await importHistory(), await send()] as const;
        }
        if (ordering === "send-first") {
          const accepted = await send();
          return [await importHistory(), accepted] as const;
        }
        return await Promise.all([importHistory(), send()]);
      }
      const [migration, accepted] = await requests();
      if (ordering !== "concurrent") {
        expect(migration.body.migrated).toBe(ordering === "import-first");
      }
      if (accepted.status !== 201) {
        throw new Error("Expected the workflow input to be accepted");
      }
      const history = await composer(actor, agentId);
      expect(history).toContainEqual(
        expect.objectContaining({
          id: actualId,
          lastUsedAt: recencyTime(acceptedTime(accepted.body)),
        }),
      );
      expect(history).toContainEqual(
        expect.objectContaining({
          id: legacyId,
          lastUsedAt: migration.body.migrated
            ? "1970-01-01T00:00:00.000010Z"
            : null,
        }),
      );
      const ranked = [...history].sort((a, b) => {
        return (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "");
      });
      expect(ranked[0]?.id).toBe(actualId);
      const replay = await accept(
        collectionClient().migrateRecency({
          headers: headers(actor),
          body: { workflowIds: [legacyId, actualId] },
        }),
        [200],
      );
      expect(replay.body).toStrictEqual({ migrated: false });
      await expect(composer(actor, agentId)).resolves.toStrictEqual(history);
    },
  );

  it("does not count preparation or automated webhooks, but accepts each manual Run now as a distinct use", async () => {
    const { actor, agentId } = await setup("team");
    const workflowId = await createWorkflow(actor, agentId, "recency-manual");
    await accept(
      detailClient().chatThread({
        headers: headers(actor),
        params: { workflowId },
      }),
      [200],
    );
    await expect(composer(actor, agentId)).resolves.toContainEqual(
      expect.objectContaining({ id: workflowId, lastUsedAt: null }),
    );
    const automation = await accept(
      automationsClient().create({
        headers: headers(actor),
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    if (
      automation.body.kind !== "event" ||
      automation.body.eventType !== "webhook-received" ||
      !automation.body.webhookUrl ||
      !automation.body.webhookSecret
    ) {
      throw new Error("Expected a webhook automation");
    }
    const payload = JSON.stringify({ event: "automatic delivery" });
    const timestamp = Math.floor(now() / 1000);
    const response = await createApp({
      signal: context.signal,
      routes: webhooksWorkflowAutomationsRoutes,
    }).request(new URL(automation.body.webhookUrl).pathname, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Okou-Timestamp": String(timestamp),
        "X-Okou-Signature": computeHmacSignature(
          payload,
          automation.body.webhookSecret,
          timestamp,
        ),
      },
      body: payload,
    });
    expect(response.status).toBe(200);
    await expect(composer(actor, agentId)).resolves.toContainEqual(
      expect.objectContaining({ id: workflowId, lastUsedAt: null }),
    );

    const firstTime = now();
    mockNow(firstTime);
    await accept(
      automationsClient().run({
        headers: headers(actor),
        params: { id: automation.body.id },
      }),
      [201],
    );
    await expect(composer(actor, agentId)).resolves.toContainEqual(
      expect.objectContaining({
        id: workflowId,
        lastUsedAt: recencyTime(firstTime),
      }),
    );
    mockNow(firstTime + 60_000);
    await accept(
      automationsClient().run({
        headers: headers(actor),
        params: { id: automation.body.id },
      }),
      [201],
    );
    await expect(composer(actor, agentId)).resolves.toContainEqual(
      expect.objectContaining({
        id: workflowId,
        lastUsedAt: recencyTime(firstTime + 60_000),
      }),
    );
  });

  it("leaves scheduled acceptance out of recency while counting Run now on that same schedule", async () => {
    const cron = await setupApp({
      context,
      routes: cronExecuteWorkflowAutomationsRoutes,
      isolatePg: true,
    });
    const { actor, agentId } = await setup();
    const workflowId = await createWorkflow(actor, agentId, "recency-schedule");
    const automation = await accept(
      automationsClient().create({
        headers: headers(actor),
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 3600 } },
      }),
      [201],
    );
    if (!automation.body.nextRunAt) {
      throw new Error("Expected a due schedule occurrence");
    }
    mockNow(new Date(automation.body.nextRunAt));
    const tick = await accept(
      cron(cronExecuteWorkflowAutomationsContract).execute({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [200],
    );
    expect(tick.body.executed).toBeGreaterThan(0);
    const updated = await accept(
      automationsClient().get({
        headers: headers(actor),
        params: { id: automation.body.id },
      }),
      [200],
    );
    expect(updated.body.nextRunAt).not.toBe(automation.body.nextRunAt);
    await expect(composer(actor, agentId)).resolves.toContainEqual(
      expect.objectContaining({ id: workflowId, lastUsedAt: null }),
    );
    await accept(
      automationsClient().run({
        headers: headers(actor),
        params: { id: automation.body.id },
      }),
      [201],
    );
    await expect(composer(actor, agentId)).resolves.toContainEqual(
      expect.objectContaining({
        id: workflowId,
        lastUsedAt: recencyTime(now()),
      }),
    );
  });

  it("keeps user/workspace history isolated and follows workflow identity through rename and replacement", async () => {
    const { actor, agentId } = await setup();
    const workflowId = await createWorkflow(actor, agentId, "recency-identity");
    const accepted = await chat.requestSendEvent(
      actor,
      { agentId, prompt: "/recency-identity" },
      [201],
    );
    if (accepted.status !== 201) {
      throw new Error("Expected the workflow input to be accepted");
    }
    const other = wf.user({ orgId: actor.orgId, orgRole: "org:member" });
    // Clerk initializes this member's Memory without initializing preferences.
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "organizationMembership.created",
      data: {
        id: `membership-${other.userId}-${other.orgId}`,
        organization: { id: other.orgId },
        public_user_data: { user_id: other.userId },
        role: other.orgRole,
        created_at: now(),
      },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
    await expect(composer(other, agentId)).resolves.toContainEqual(
      expect.objectContaining({ id: workflowId, lastUsedAt: null }),
    );
    // The default-off peer can send, but cannot create or read server history.
    mockNow(Date.parse(acceptedTime(accepted.body)) + 60_000);
    await chat.requestSendEvent(
      other,
      {
        agentId,
        prompt: "/recency-identity",
        model: null,
      },
      [201],
    );
    await expect(composer(other, agentId)).resolves.toContainEqual(
      expect.objectContaining({
        id: workflowId,
        lastUsedAt: null,
      }),
    );
    await expect(composer(wf.user(), agentId)).resolves.toStrictEqual([]);
    await accept(
      detailClient().update({
        headers: headers(actor),
        params: { workflowId },
        body: { name: "recency-renamed" },
      }),
      [200],
    );
    await expect(composer(actor, agentId)).resolves.toContainEqual(
      expect.objectContaining({
        id: workflowId,
        name: "recency-renamed",
        lastUsedAt: recencyTime(acceptedTime(accepted.body)),
      }),
    );
    await accept(
      detailClient().delete({
        headers: headers(actor),
        params: { workflowId },
      }),
      [204],
    );
    const replacementId = await createWorkflow(
      actor,
      agentId,
      "recency-renamed",
    );
    await expect(composer(actor, agentId)).resolves.toStrictEqual([
      expect.objectContaining({ id: replacementId, lastUsedAt: null }),
    ]);
  });

  it.each([true, false])(
    "honors the recency flag for PAT migration, slash, direct runs and Run now (enabled: %s)",
    async (enabled) => {
      const { actor, agentId } = await setup();
      const workflowId = await createWorkflow(actor, agentId, "recency-pat");
      if (!actor.orgId) {
        throw new Error("Expected a workflow workspace");
      }
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId: actor.orgId },
        { [FeatureSwitchKey.WorkflowRecency]: enabled },
      );
      const { token } = await runs.createCliToken(actor);
      const tokenHeaders = { authorization: `Bearer ${token}` };
      const migrated = await accept(
        collectionClient().migrateRecency({
          headers: tokenHeaders,
          body: { workflowIds: [workflowId] },
        }),
        [enabled ? 200 : 403],
      );
      if (enabled) {
        expect(migrated.body).toStrictEqual({ migrated: true });
      }
      await expect(composer(actor, agentId)).resolves.toContainEqual(
        expect.objectContaining({
          id: workflowId,
          lastUsedAt: enabled ? "1970-01-01T00:00:00.000010Z" : null,
        }),
      );
      const slashAt = now() + 60_000;
      mockNow(slashAt);
      const sent = await accept(
        setupApp({ context, routes: chatEventsRoutes })(
          chatEventsContract,
        ).send({
          headers: tokenHeaders,
          body: {
            agentId,
            prompt: "/recency-pat",
            hasTextContent: true,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "/recency-pat" }],
            },
          },
        }),
        [201],
      );
      await expect(composer(actor, agentId)).resolves.toContainEqual(
        expect.objectContaining({
          id: workflowId,
          lastUsedAt: enabled ? recencyTime(acceptedTime(sent.body)) : null,
        }),
      );
      const automation = await accept(
        automationsClient().create({
          headers: headers(actor),
          params: { workflowId },
          body: { schedule: { type: "loop", intervalSeconds: 3600 } },
        }),
        [201],
      );
      const manualAt = slashAt + 60_000;
      mockNow(manualAt);
      await accept(
        automationsClient().run({
          headers: tokenHeaders,
          params: { id: automation.body.id },
        }),
        [201],
      );
      await expect(composer(actor, agentId)).resolves.toContainEqual(
        expect.objectContaining({
          id: workflowId,
          lastUsedAt: enabled ? recencyTime(manualAt) : null,
        }),
      );
      const directAt = manualAt + 60_000;
      mockNow(directAt);
      await accept(
        detailClient().run({
          headers: tokenHeaders,
          params: { workflowId },
        }),
        [200],
      );
      if (!enabled) {
        await updateFeatureSwitchesForUser(
          context,
          { ...actor, orgId: actor.orgId },
          { [FeatureSwitchKey.WorkflowRecency]: true },
        );
      }
      await expect(composer(actor, agentId)).resolves.toContainEqual(
        expect.objectContaining({
          id: workflowId,
          lastUsedAt: enabled ? recencyTime(directAt) : null,
        }),
      );
      await flushWaitUntilForTest();
    },
  );

  it("accepts real agent-token migration and sends while retaining the internal Run now source exclusion", async () => {
    const { actor, agentId } = await setup();
    const workflowId = await createWorkflow(actor, agentId, "recency-agent");
    const anchor = await runs.createThreadRun(actor, {
      agentId,
      prompt: "Start the parent run",
    });
    const execution = await runs.executionInput(anchor.runId);
    const token = execution.platformEnvironment.OKOU_TOKEN;
    if (!token) {
      throw new Error("Expected the production Run agent token");
    }
    await accept(
      collectionClient().migrateRecency({
        headers: { authorization: `Bearer ${token}` },
        body: { workflowIds: [workflowId] },
      }),
      [200],
    );
    await expect(composer(actor, agentId)).resolves.toContainEqual(
      expect.objectContaining({
        id: workflowId,
        lastUsedAt: "1970-01-01T00:00:00.000010Z",
      }),
    );
    const sent = await accept(
      setupApp({ context, routes: chatEventsRoutes })(chatEventsContract).send({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId,
          prompt: "/recency-agent",
          hasTextContent: true,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "/recency-agent" }],
          },
        },
      }),
      [201],
    );
    const automation = await accept(
      automationsClient().create({
        headers: headers(actor),
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 3600 } },
      }),
      [201],
    );
    const beforeInternalRun = await composer(actor, agentId);
    expect(beforeInternalRun).toContainEqual(
      expect.objectContaining({
        id: workflowId,
        lastUsedAt: recencyTime(acceptedTime(sent.body)),
      }),
    );
    const directAt = Date.parse(acceptedTime(sent.body)) + 120_000;
    mockNow(directAt - 60_000);
    await accept(
      automationsClient().run({
        headers: { authorization: `Bearer ${token}` },
        params: { id: automation.body.id },
      }),
      [201],
    );
    await expect(composer(actor, agentId)).resolves.toStrictEqual(
      beforeInternalRun,
    );
    mockNow(directAt);
    await accept(
      detailClient().run({
        headers: { authorization: `Bearer ${token}` },
        params: { workflowId },
      }),
      [200],
    );
    await expect(composer(actor, agentId)).resolves.toContainEqual(
      expect.objectContaining({
        id: workflowId,
        lastUsedAt: recencyTime(directAt),
      }),
    );
    await flushWaitUntilForTest();
  });
});
