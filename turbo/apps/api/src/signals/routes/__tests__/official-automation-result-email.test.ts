import { mockClerkUsers } from "./helpers/clerk-users";
import { createHash, createHmac, randomUUID } from "node:crypto";

import { testWorkflowAutomationExecutionContract } from "@okouai/api-contracts/contracts/test-workflow-automation-execution";
import {
  workflowAutomationsContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { createStore } from "ccstate";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { completeRunWithoutCallbacksFixture } from "../../../test-fixtures/chat-events";
import {
  clearResultEmailUserStateFixture,
  completeResultEmailRunWithoutCallbacksFixture,
  holdResultEmailClaimBoundaryFixture,
  markWorkflowAsMorningBriefResultEmailFixture,
  readResultEmailPreferenceFixture,
} from "../../../test-fixtures/official-automation-result-email";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createEmailOutboxStateApi } from "./helpers/email-outbox-state";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import {
  readAgentRunCallbacks$,
  seedAgentRunCallback$,
} from "./helpers/agent-run-callback";
import { createRouteMocks } from "./helpers/route-test";
import { testWorkflowAutomationExecutionRoutes } from "../test-workflow-automation-execution";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const workflows = createWorkflowsBddApi(context);
const outbox = createEmailOutboxStateApi(context);
const misc = createMiscRoutesApi(context);

const WORKFLOW_NAME = "official-result-email-fixture";
const RESULT_CALLBACK_KIND = "workflow-automation:result-email";
const OUTBOX_TTL_MS = 15 * 60 * 1000;

interface Scenario {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly workflowId: string;
  readonly automationId: string;
  readonly runnerGroup: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function workflowClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}

function executionClient() {
  return setupApp({
    context,
    routes: testWorkflowAutomationExecutionRoutes,
  })(testWorkflowAutomationExecutionContract);
}

function clerkUser(userId: string, email: string) {
  const emailId = `email_${userId}`;
  return {
    id: userId,
    emailAddresses: [{ id: emailId, emailAddress: email }],
    primaryEmailAddressId: emailId,
    firstName: "Official",
    lastName: "Automation",
    imageUrl: null,
  };
}

async function setupScenario(): Promise<Scenario> {
  const runnerGroup = runs.configureRunnerGroup();
  const { actor } = await workflows.setupWorkflowOrg();
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  const { agentId } = await workflows.createAgent(actor, {
    displayName: "Official result email agent",
  });
  const workflowId = await workflows.createWorkflow(actor, {
    agentId,
    name: WORKFLOW_NAME,
  });
  mocks.clerk.session(actor.userId, actor.orgId, "org:member");
  mockClerkUsers(context, [clerkUser(actor.userId, actor.email)]);
  context.mocks.s3.send.mockResolvedValue({});
  const automation = await accept(
    automationsClient().create({
      headers: authHeaders(),
      params: { workflowId },
      body: { schedule: { type: "loop", intervalSeconds: 3600 } },
    }),
    [201],
  );
  return {
    actor,
    agentId,
    workflowId,
    automationId: automation.body.id,
    runnerGroup,
  };
}

async function startRun(
  scenario: Scenario,
  origin = "https://app.okou.ai",
): Promise<string> {
  const response = await accept(
    automationsClient().run({
      headers: authHeaders(),
      extraHeaders: { origin },
      params: { id: scenario.automationId },
    }),
    [201],
  );
  if (!response.body.runId) {
    throw new Error("Expected an idle Automation run to start");
  }
  await flushWaitUntilForTest();
  return response.body.runId;
}

async function seedResultCallback(args: {
  readonly runId: string;
  readonly automationId: string;
  readonly publicBrand: "vm0" | "okou";
  readonly workflowName?: string;
  readonly status?: "pending" | "failed";
}): Promise<string> {
  const seeded = await store.set(
    seedAgentRunCallback$,
    {
      runId: args.runId,
      internalKind: RESULT_CALLBACK_KIND,
      payload: {
        automationId: args.automationId,
        workflowName: args.workflowName ?? WORKFLOW_NAME,
        publicBrand: args.publicBrand,
      },
      status: args.status,
    },
    context.signal,
  );
  return seeded.callbackId;
}

async function resultCallbackState(scenario: Scenario, runId: string) {
  const callbacks = await runCallbackState(scenario, runId);
  return callbacks.filter((callback) => {
    return callback.internalKind === RESULT_CALLBACK_KIND;
  });
}

async function runCallbackState(scenario: Scenario, runId: string) {
  return await store.set(
    readAgentRunCallbacks$,
    {
      orgId: scenario.actor.orgId!,
      userId: scenario.actor.userId,
      runId,
    },
    context.signal,
  );
}

async function claimAndReportOutput(
  scenario: Scenario,
  runId: string,
  output?: string,
) {
  await runs.heartbeatRunner(scenario.runnerGroup);
  const claim = await runs.claimRunnerJob(runId);
  const headers = { authorization: `Bearer ${claim.sandboxToken}` };
  if (output !== undefined) {
    await webhooks.requestAgentEvents(
      {
        runId,
        events: [{ type: "result", sequenceNumber: 0, result: output }],
      },
      headers,
      [200],
    );
  }
  return { headers, lastEventSequence: output === undefined ? undefined : 0 };
}

async function completeRun(
  scenario: Scenario,
  runId: string,
  args: { readonly exitCode: number; readonly output?: string },
): Promise<void> {
  const reported = await claimAndReportOutput(scenario, runId, args.output);
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: args.exitCode,
      checkpoint: {
        cliAgentType: "claude-code",
        cliAgentSessionId: `official-result-email-${runId}`,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(`official result email history ${runId}`)
          .digest("hex"),
      },
      ...(reported.lastEventSequence === undefined
        ? {}
        : { lastEventSequence: reported.lastEventSequence }),
    },
    reported.headers,
    [200],
  );
  await flushWaitUntilForTest();
}

function unsubscribeToken(userId: string): string {
  const signature = createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`unsubscribe:${userId}`)
    .digest("hex")
    .slice(0, 32);
  return `${userId}.${signature}`;
}

beforeEach(() => {
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("RESEND_API_KEY", "official-result-email-resend-key");
  mockEnv("RESEND_FROM_DOMAIN", "mail.example.com");
  mockEnv("RESEND_WEBHOOK_SECRET", "whsec_test");
  mockOptionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS", "0");
  context.mocks.resend.send.mockReset();
  context.mocks.resend.send.mockResolvedValue({
    data: { id: `resend-${randomUUID()}` },
    error: null,
  });
});

describe("Official Automation result email callbacks", () => {
  it("does not attach the Official result callback to a direct Workflow run", async () => {
    const scenario = await setupScenario();
    const directRun = await accept(
      workflowClient().run({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
      }),
      [200],
    );
    if (!directRun.body.runId) {
      throw new Error("Expected the direct Workflow run to start");
    }
    expect(
      (await runCallbackState(scenario, directRun.body.runId)).some(
        (callback) => {
          return callback.internalKind === RESULT_CALLBACK_KIND;
        },
      ),
    ).toBeFalsy();
    await runs.requestCancelRun(scenario.actor, directRun.body.runId, [200]);
    await flushWaitUntilForTest();
  });

  it("keeps ordinary success ineligible and selects the session or agent-token brand", async () => {
    const scenario = await setupScenario();
    const sessionRunId = await startRun(scenario, "https://app.okou.ai");
    const sessionCallbacks = await runCallbackState(scenario, sessionRunId);
    expect(sessionCallbacks).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          internalKind: "chat",
          payload: expect.objectContaining({ publicBrand: "okou" }),
        }),
      ]),
    );
    expect(
      sessionCallbacks.some((callback) => {
        return callback.internalKind === RESULT_CALLBACK_KIND;
      }),
    ).toBeFalsy();
    await completeRun(scenario, sessionRunId, {
      exitCode: 0,
      output: "Ordinary Automation result",
    });
    expect((await runs.readRun(scenario.actor, sessionRunId)).status).toBe(
      "completed",
    );
    await expect(
      outbox.findSourceState({
        sourceRunId: sessionRunId,
        sourceWorkflowAutomationId: scenario.automationId,
      }),
    ).resolves.toStrictEqual({ items: [], claim: null });

    const agentToken = runs.okouTokenForRunWithCapabilities(
      scenario.actor,
      sessionRunId,
      ["agent:write"],
    );
    const agentRun = await accept(
      automationsClient().run({
        headers: { authorization: `Bearer ${agentToken}` },
        extraHeaders: { origin: "https://app.okou.ai" },
        params: { id: scenario.automationId },
      }),
      [201],
    );
    if (!agentRun.body.runId) {
      throw new Error("Expected the agent-token Automation run to start");
    }
    await expect(
      runCallbackState(scenario, agentRun.body.runId),
    ).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          internalKind: "chat",
          payload: expect.objectContaining({ publicBrand: "okou" }),
        }),
      ]),
    );
    await runs.requestCancelRun(scenario.actor, agentRun.body.runId, [200]);
    await flushWaitUntilForTest();
  });

  it("links Morning Brief management to Preferences without changing account unsubscribe", async () => {
    const scenario = await setupScenario();
    const runId = await startRun(scenario, "https://app.okou.ai");
    await seedResultCallback({
      runId,
      automationId: scenario.automationId,
      publicBrand: "okou",
      workflowName: "Morning Brief",
    });
    await completeResultEmailRunWithoutCallbacksFixture(runId);
    await markWorkflowAsMorningBriefResultEmailFixture(scenario.workflowId);
    await accept(
      executionClient().interruptResultEmailCallback({
        body: { run_id: runId },
      }),
      [200],
    );
    const source = await outbox.findSourceState({
      sourceRunId: runId,
      sourceWorkflowAutomationId: scenario.automationId,
    });
    const item = source.items[0];
    if (!item) {
      throw new Error("Expected a Morning Brief result email");
    }
    expect(item.subject).toBe("Morning Brief");
    const manageUrl =
      "https://app.okou.ai/agents?settings=preference&focus=morning-brief";
    const accountUnsubscribeUrl = `https://app.okou.ai/email/unsubscribe?token=${unsubscribeToken(
      scenario.actor.userId,
    )}`;
    expect(item.template).toMatchObject({
      template: "official-automation-result",
      props: { manageUrl },
    });
    expect(item.headers).toStrictEqual({
      "List-Unsubscribe": `<https://api.okou.ai/api/email/unsubscribe?token=${unsubscribeToken(
        scenario.actor.userId,
      )}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });

    await expect(outbox.drainItems([item.id])).resolves.toBe(1);
    const send = context.mocks.resend.send.mock.calls[0]?.[0];
    const html =
      typeof send === "object" &&
      send !== null &&
      "html" in send &&
      typeof send.html === "string"
        ? send.html
        : "";
    expect(html).toContain(
      'alt="Wake up to what matters. Your morning brief is ready."',
    );
    expect(html).toContain(
      'href="https://app.okou.ai/agents?settings=preference&amp;focus=morning-brief"',
    );
    expect(html).toContain(
      `>Manage</a> &middot; <a href="${accountUnsubscribeUrl}"`,
    );
  });

  it("retries independently of Run success and renders bounded Okou Markdown multipart output for a VM0 snapshot", async () => {
    const scenario = await setupScenario();
    const runId = await startRun(scenario, "https://app.okou.ai");
    const longPlainText = `LONG_PLAIN_TEXT_${"x".repeat(160)}`;
    const hostileOutput = [
      "## Priorities",
      "",
      "- **Reply** to the [customer](https://example.com/customer)",
      "- [Email](MAILTO:user@example.com?subject=Hello)",
      "- [javascript](jav&#x61;script:alert(1))",
      "- [percent-obfuscated](java%73cript:alert(1))",
      "- [data](data:text/html;base64,PHNjcmlwdD4=)",
      "- [file](file:///etc/passwd)",
      "- [cid](cid:tracking-pixel)",
      "- [protocol-relative](//evil.example/path)",
      "- [root-relative](/relative/path)",
      "- [relative](../relative/path)",
      "- [http](http://example.com/path)",
      "- [other-scheme](ftp://example.com/file)",
      "- [malformed-https](https://%zz.example/path)",
      "- [non-absolute-https](https:relative/path)",
      "- [empty-mailto](mailto:)",
      "- ![tracking pixel](https://tracker.example/pixel.png)",
      "",
      "1. First ordered item",
      "2. Second ordered item",
      "",
      "> A quoted decision",
      "",
      "Use `inlineCode()` here.",
      "",
      "```mermaid",
      "graph TD",
      "A[Start] --> B[Done]",
      "```",
      "",
      "| Owner | Priority |",
      "| --- | --- |",
      "| Sales | High |",
      "",
      longPlainText,
      "",
      '<script>alert("unsafe") &</script>',
      "<style>* { display:none }</style>",
      '<img src="x" onerror="alert(1)">',
      '<svg onload="alert(1)"><path /></svg>',
      '<iframe srcdoc="unsafe"></iframe>',
      '<div onclick="alert(1)">click</div>',
      "😀".repeat(9000),
    ].join("\n");
    const resultCallbackId = await seedResultCallback({
      runId,
      automationId: scenario.automationId,
      publicBrand: "vm0",
      workflowName: 'Official <script> & " result',
    });

    mockEnv("RESEND_FROM_DOMAIN", undefined);
    await completeRun(scenario, runId, {
      exitCode: 0,
      output: hostileOutput,
    });
    expect((await runs.readRun(scenario.actor, runId)).status).toBe(
      "completed",
    );
    await expect(resultCallbackState(scenario, runId)).resolves.toMatchObject([
      { status: "failed", attempts: 1 },
    ]);
    await expect(runCallbackState(scenario, runId)).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          internalKind: "chat",
          status: "delivered",
        }),
      ]),
    );
    await expect(
      outbox.findSourceState({
        sourceRunId: runId,
        sourceWorkflowAutomationId: scenario.automationId,
      }),
    ).resolves.toStrictEqual({ items: [], claim: null });

    mockEnv("RESEND_FROM_DOMAIN", "okou.io");
    const redrive = await accept(
      executionClient().dispatchCallbacks({
        body: { run_id: runId, status: "completed", dispatch_count: 8 },
      }),
      [200],
    );
    expect(redrive.body.successful_callbacks).toBeGreaterThan(0);
    await expect(resultCallbackState(scenario, runId)).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: resultCallbackId,
          status: "delivered",
        }),
      ]),
    );

    const source = await outbox.findSourceState({
      sourceRunId: runId,
      sourceWorkflowAutomationId: scenario.automationId,
    });
    expect(source.claim).not.toBeNull();
    expect(source.items).toHaveLength(1);
    const item = source.items[0]!;
    expect(source.claim?.email_outbox_id).toBe(item.id);
    expect(item).toMatchObject({
      from_address: "Okou <okou@okou.io>",
      to_addresses: scenario.actor.email,
      public_brand: "okou",
      status: "pending",
      source_run_id: runId,
      source_workflow_automation_id: scenario.automationId,
      headers: {
        "List-Unsubscribe": `<https://api.okou.ai/api/email/unsubscribe?token=${unsubscribeToken(scenario.actor.userId)}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    expect(item.subject.length).toBeLessThanOrEqual(180);
    expect(item.template).toMatchObject({
      template: "official-automation-result",
      props: {
        resultText: expect.stringContaining("[Result truncated]"),
        runUrl: `https://app.okou.ai/activities/${runId}`,
        manageUrl: `https://app.okou.ai/workflows/${scenario.workflowId}/automations?automationId=${scenario.automationId}`,
      },
    });
    const automationUrl = `https://app.okou.ai/workflows/${scenario.workflowId}/automations?automationId=${scenario.automationId}`;
    const accountUnsubscribeUrl = `https://app.okou.ai/email/unsubscribe?token=${unsubscribeToken(
      scenario.actor.userId,
    )}`;
    expect(automationUrl).not.toContain("token=");
    expect(item.headers).toStrictEqual({
      "List-Unsubscribe": `<https://api.okou.ai/api/email/unsubscribe?token=${unsubscribeToken(
        scenario.actor.userId,
      )}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });

    await expect(outbox.drainItems([item.id])).resolves.toBe(1);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    const send = context.mocks.resend.send.mock.calls[0]?.[0];
    expect(send).toMatchObject({
      from: "Okou <okou@okou.io>",
      to: scenario.actor.email,
      subject: 'Official <script> & " result',
      headers: {
        "List-Unsubscribe": `<https://api.okou.ai/api/email/unsubscribe?token=${unsubscribeToken(scenario.actor.userId)}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    const html =
      typeof send === "object" &&
      send !== null &&
      "html" in send &&
      typeof send.html === "string"
        ? send.html
        : "";
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<style>");
    expect(html).not.toContain('<img src="x"');
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<iframe");
    expect(html).not.toMatch(/<[^>]+\son(?:click|error|load)=/u);
    expect(html).not.toContain("tracker.example");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;style&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
    expect(html).toContain(
      "<title>Result from Official &lt;script&gt; &amp; &quot; result</title>",
    );
    expect(html).toContain(">Priorities</h2>");
    expect(html).toContain("<ul style=");
    expect(html).toContain("<ol style=");
    expect(html).toContain("<blockquote style=");
    expect(html).toContain("<code style=");
    expect(html).toContain("<pre style=");
    expect(html).toContain("A[Start] --&gt; B[Done]");
    expect(html).toContain('<table role="presentation" width="100%"');
    expect(html).toContain("<th style=");
    expect(html).toContain("<td style=");
    expect(html).toContain("<strong style=");
    expect(html).toContain('href="https://example.com/customer"');
    expect(html).toContain('href="MAILTO:user@example.com?subject=Hello"');
    for (const unsafeDestination of [
      "javascript:",
      "java%73cript:",
      "data:",
      "file:",
      "cid:",
      "//evil.example",
      "/relative/path",
      "../relative/path",
      "http://",
      "ftp://",
      "https://%zz",
      "https:relative",
      "mailto:",
    ]) {
      expect(html).not.toContain(`href="${unsafeDestination}`);
    }
    expect(html).toContain("[Result truncated]");
    expect(html).toContain("Okou");
    expect(html).toContain(">Open in Okou &rarr;</a>");
    expect(html).toContain(`https://app.okou.ai/activities/${runId}`);
    expect(html).toContain("Sent by an Okou automation &middot;");
    expect(html).toContain(`href="${automationUrl}"`);
    expect(html).toContain(
      `>Manage</a> &middot; <a href="${accountUnsubscribeUrl}"`,
    );
    expect(html).toContain(">Unsubscribe</a>");
    expect(automationUrl).not.toBe(accountUnsubscribeUrl);
    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(96 * 1024);

    const text =
      typeof send === "object" &&
      send !== null &&
      "text" in send &&
      typeof send.text === "string"
        ? send.text
        : "";
    expect(text).not.toBe("");
    expect(text.toLowerCase()).toContain("priorities");
    expect(text).toContain("Reply");
    expect(text).toContain("https://example.com/customer");
    expect(text).toContain(longPlainText);
    expect(text).toContain("[Result truncated]");
    expect(text).toContain(`https://app.okou.ai/activities/${runId}`);
    expect(text).not.toContain('Result from Official <script> & " result');
    expect(text).toContain(
      `Sent by an Okou automation · Manage [${automationUrl}] · Unsubscribe [${accountUnsubscribeUrl}]`,
    );
  });

  it("falls back after pathological Markdown expansion and sends one bounded multipart email", async () => {
    const scenario = await setupScenario();
    const runId = await startRun(scenario, "https://app.okou.ai");
    await seedResultCallback({
      runId,
      automationId: scenario.automationId,
      publicBrand: "okou",
    });
    const pathologicalOutput = Array.from({ length: 2000 }, () => {
      return "- x";
    }).join("\n");
    expect(Array.from(pathologicalOutput)).toHaveLength(7999);

    await completeRun(scenario, runId, {
      exitCode: 0,
      output: pathologicalOutput,
    });
    expect((await runs.readRun(scenario.actor, runId)).status).toBe(
      "completed",
    );
    await expect(resultCallbackState(scenario, runId)).resolves.toMatchObject([
      { status: "delivered", attempts: 1 },
    ]);

    const source = await outbox.findSourceState({
      sourceRunId: runId,
      sourceWorkflowAutomationId: scenario.automationId,
    });
    const item = source.items[0];
    if (!item) {
      throw new Error("Expected pathological output to enqueue one email");
    }
    expect(item.template).toMatchObject({
      template: "official-automation-result",
      props: { resultText: pathologicalOutput },
    });

    await expect(outbox.drainItems([item.id])).resolves.toBe(1);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    const send = context.mocks.resend.send.mock.calls[0]?.[0];
    const html =
      typeof send === "object" &&
      send !== null &&
      "html" in send &&
      typeof send.html === "string"
        ? send.html
        : "";
    const text =
      typeof send === "object" &&
      send !== null &&
      "text" in send &&
      typeof send.text === "string"
        ? send.text
        : "";
    expect(html).toContain("white-space:pre-wrap");
    expect(html).not.toContain("<li");
    expect(html).toContain("- x\n- x");
    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(96 * 1024);
    expect(text).toContain("- x\n- x");
    expect(text).toContain(`https://app.okou.ai/activities/${runId}`);
    expect(text).toContain("https://app.okou.ai/email/unsubscribe");
    await expect(outbox.readItem(item.id)).resolves.toMatchObject({
      status: "sent",
      attempts: 1,
    });
  });

  it("keeps the existing automation switch separate from account-level unsubscribe", async () => {
    const scenario = await setupScenario();
    await clearResultEmailUserStateFixture(scenario.actor.userId);
    await expect(
      readResultEmailPreferenceFixture(scenario.actor.userId),
    ).resolves.toBeNull();

    const disabled = await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: scenario.automationId },
      }),
      [200],
    );

    expect(disabled.body.enabled).toBeFalsy();
    await expect(
      readResultEmailPreferenceFixture(scenario.actor.userId),
    ).resolves.toBeNull();

    await misc.requestEmailUnsubscribe(
      unsubscribeToken(scenario.actor.userId),
      [200],
    );
    await expect(
      readResultEmailPreferenceFixture(scenario.actor.userId),
    ).resolves.toBeTruthy();
  });

  it("keeps suppression at send and leaves a successful Run unchanged", async () => {
    const scenario = await setupScenario();
    const runId = await startRun(scenario);
    await seedResultCallback({
      runId,
      automationId: scenario.automationId,
      publicBrand: "vm0",
    });
    await completeRun(scenario, runId, { exitCode: 0 });
    const source = await outbox.findSourceState({
      sourceRunId: runId,
      sourceWorkflowAutomationId: scenario.automationId,
    });
    const item = source.items[0];
    if (!item) {
      throw new Error("Expected the successful Run to enqueue one email");
    }
    expect(item.template).toMatchObject({
      template: "official-automation-result",
      props: {
        resultText: "This run completed without a text result.",
      },
    });

    const bounced = {
      type: "email.bounced",
      data: {
        email_id: `email_${randomUUID()}`,
        to: [scenario.actor.email],
      },
    };
    await webhooks.requestResendInboundWebhook(
      bounced,
      webhooks.signedResendWebhookHeaders(bounced),
      [200],
    );
    await expect(outbox.drainItems([item.id])).resolves.toBe(1);
    expect(context.mocks.resend.send).not.toHaveBeenCalled();
    await expect(outbox.readItem(item.id)).resolves.toMatchObject({
      status: "failed",
      last_error: expect.stringContaining("suppressed"),
    });
    expect((await runs.readRun(scenario.actor, runId)).status).toBe(
      "completed",
    );
  });

  describe("with a seeded cancellation callback", () => {
    async function prepareScenario() {
      const cancelledScenario = await setupScenario();

      const cancelledRunId = await startRun(cancelledScenario);
      await seedResultCallback({
        runId: cancelledRunId,
        automationId: cancelledScenario.automationId,
        publicBrand: "vm0",
      });
      return { cancelledScenario, cancelledRunId };
    }
    let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
    beforeEach(async () => {
      preparedScenario = await prepareScenario();
    });
    it("delivers cancellation callbacks without an outbox retry loop", async () => {
      const { cancelledScenario, cancelledRunId } = preparedScenario;
      await runs.requestCancelRun(
        cancelledScenario.actor,
        cancelledRunId,
        [200],
      );
      await flushWaitUntilForTest();
      await expect(
        resultCallbackState(cancelledScenario, cancelledRunId),
      ).resolves.toMatchObject([{ status: "delivered", attempts: 1 }]);
      const cancellationRetryCallbackId = await seedResultCallback({
        runId: cancelledRunId,
        automationId: cancelledScenario.automationId,
        publicBrand: "vm0",
        status: "failed",
      });
      const cancellationRedrive = await accept(
        executionClient().dispatchCallbacks({
          body: {
            run_id: cancelledRunId,
            status: "failed",
            error: "Run cancelled",
            dispatch_count: 8,
          },
        }),
        [200],
      );
      expect(cancellationRedrive.body.successful_callbacks).toBeGreaterThan(0);
      await expect(
        resultCallbackState(cancelledScenario, cancelledRunId),
      ).resolves.toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: cancellationRetryCallbackId,
            status: "delivered",
          }),
        ]),
      );
      await expect(
        outbox.findSourceState({
          sourceRunId: cancelledRunId,
          sourceWorkflowAutomationId: cancelledScenario.automationId,
        }),
      ).resolves.toStrictEqual({ items: [], claim: null });
    });
  });

  describe("with a seeded failure callback", () => {
    async function prepareScenario() {
      const failedScenario = await setupScenario();
      const failedRunId = await startRun(failedScenario);
      await seedResultCallback({
        runId: failedRunId,
        automationId: failedScenario.automationId,
        publicBrand: "vm0",
      });
      return { failedScenario, failedRunId };
    }
    let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
    beforeEach(async () => {
      preparedScenario = await prepareScenario();
    });
    it("delivers terminal-failure callbacks without an outbox retry loop", async () => {
      const { failedScenario, failedRunId } = preparedScenario;
      await completeRun(failedScenario, failedRunId, { exitCode: 1 });
      await expect(
        resultCallbackState(failedScenario, failedRunId),
      ).resolves.toMatchObject([{ status: "delivered", attempts: 1 }]);
      await expect(
        outbox.findSourceState({
          sourceRunId: failedRunId,
          sourceWorkflowAutomationId: failedScenario.automationId,
        }),
      ).resolves.toStrictEqual({ items: [], claim: null });
    });
  });

  describe("with a seeded successful callback", () => {
    async function prepareScenario() {
      const unsubscribedScenario = await setupScenario();
      const unsubscribedRunId = await startRun(unsubscribedScenario);
      await seedResultCallback({
        runId: unsubscribedRunId,
        automationId: unsubscribedScenario.automationId,
        publicBrand: "vm0",
      });
      return { unsubscribedScenario, unsubscribedRunId };
    }
    let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
    beforeEach(async () => {
      preparedScenario = await prepareScenario();
    });
    it("honors account unsubscribe for successful result callbacks", async () => {
      const { unsubscribedScenario, unsubscribedRunId } = preparedScenario;
      await misc.requestEmailUnsubscribe(
        unsubscribeToken(unsubscribedScenario.actor.userId),
        [200],
      );
      await completeRun(unsubscribedScenario, unsubscribedRunId, {
        exitCode: 0,
        output: "Unsubscribed result",
      });
      await expect(
        outbox.findSourceState({
          sourceRunId: unsubscribedRunId,
          sourceWorkflowAutomationId: unsubscribedScenario.automationId,
        }),
      ).resolves.toStrictEqual({ items: [], claim: null });
    });
  });

  it("rechecks an absent preference row after concurrent unsubscribe commits", async () => {
    const scenario = await setupScenario();
    const runId = await startRun(scenario);
    await seedResultCallback({
      runId,
      automationId: scenario.automationId,
      publicBrand: "vm0",
    });
    await clearResultEmailUserStateFixture(scenario.actor.userId);
    await expect(
      readResultEmailPreferenceFixture(scenario.actor.userId),
    ).resolves.toBeNull();
    await completeResultEmailRunWithoutCallbacksFixture(runId);

    const emailLookupStarted = createDeferredPromise<void>(context.signal);
    const releaseEmailLookup = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseEmailLookup.settled()) {
        releaseEmailLookup.resolve(undefined);
      }
    });
    context.mocks.clerk.users.getUser.mockImplementationOnce(async () => {
      emailLookupStarted.resolve(undefined);
      await releaseEmailLookup.promise;
      return clerkUser(scenario.actor.userId, scenario.actor.email);
    });

    const callback = executionClient().interruptResultEmailCallback({
      body: { run_id: runId },
    });
    await emailLookupStarted.promise;
    await misc.requestEmailUnsubscribe(
      unsubscribeToken(scenario.actor.userId),
      [200],
    );
    releaseEmailLookup.resolve(undefined);
    await expect(
      readResultEmailPreferenceFixture(scenario.actor.userId),
    ).resolves.toBeTruthy();
    const callbackResult = await accept(callback, [200]);
    expect(callbackResult.body).toMatchObject({ success: true, skipped: true });

    await expect(
      outbox.findSourceState({
        sourceRunId: runId,
        sourceWorkflowAutomationId: scenario.automationId,
      }),
    ).resolves.toStrictEqual({ items: [], claim: null });
  });

  it("serializes absent-row enqueue before a concurrent unsubscribe writer", async () => {
    const scenario = await setupScenario();
    const runId = await startRun(scenario);
    await seedResultCallback({
      runId,
      automationId: scenario.automationId,
      publicBrand: "vm0",
    });
    await clearResultEmailUserStateFixture(scenario.actor.userId);
    await expect(
      readResultEmailPreferenceFixture(scenario.actor.userId),
    ).resolves.toBeNull();
    await completeResultEmailRunWithoutCallbacksFixture(runId);

    const heldClaim = await holdResultEmailClaimBoundaryFixture({
      runId,
      workflowAutomationId: scenario.automationId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      heldClaim.release();
      await heldClaim.done;
    });

    const callback = executionClient().interruptResultEmailCallback({
      body: { run_id: runId },
    });
    await expect
      .poll(heldClaim.blockedWaiterCount, { interval: 2, timeout: 1000 })
      .toBe(1);

    const unsubscribe = misc.requestEmailUnsubscribe(
      unsubscribeToken(scenario.actor.userId),
      [200],
    );
    await expect
      .poll(heldClaim.blockedChainCount, { interval: 2, timeout: 1000 })
      .toBeGreaterThanOrEqual(2);

    heldClaim.release();
    const [callbackResult] = await Promise.all([
      accept(callback, [200]),
      unsubscribe,
      heldClaim.done,
    ]);
    expect(callbackResult.body).toMatchObject({
      success: true,
      skipped: false,
    });
    await expect(
      readResultEmailPreferenceFixture(scenario.actor.userId),
    ).resolves.toBeTruthy();
    const source = await outbox.findSourceState({
      sourceRunId: runId,
      sourceWorkflowAutomationId: scenario.automationId,
    });
    expect(source.claim).not.toBeNull();
    expect(source.items).toHaveLength(1);
    expect(source.items[0]?.id).toBe(source.claim?.email_outbox_id);
  });

  it.each(["pending", "failed"] as const)(
    "retains one source claim across Automation deletion, real %s TTL cleanup, and late concurrent redrive",
    async (cleanupStatus) => {
      const scenario = await setupScenario();
      const runId = await startRun(scenario);
      const callbackId = await seedResultCallback({
        runId,
        automationId: scenario.automationId,
        publicBrand: "vm0",
      });
      await claimAndReportOutput(scenario, runId, "Durable source result");
      await completeRunWithoutCallbacksFixture({ runId });

      const interrupted = await accept(
        executionClient().interruptResultEmailCallback({
          body: { run_id: runId },
        }),
        [200],
      );
      expect(interrupted.body).toStrictEqual({
        success: true,
        callback_id: callbackId,
        skipped: false,
      });
      const beforeDelete = await outbox.findSourceState({
        sourceRunId: runId,
        sourceWorkflowAutomationId: scenario.automationId,
      });
      const originalItem = beforeDelete.items[0];
      if (!originalItem || !beforeDelete.claim) {
        throw new Error(
          "Expected the interrupted callback to retain its source",
        );
      }

      const cleanupBaseTime = now();
      onTestFinished(clearMockNow);
      if (cleanupStatus === "failed") {
        context.mocks.resend.send.mockResolvedValue({
          data: null,
          error: { message: "Official result provider unavailable" },
        });
        mockNow(cleanupBaseTime);
        await outbox.drainItems([originalItem.id]);
        mockNow(cleanupBaseTime + 1000);
        await outbox.drainItems([originalItem.id]);
        mockNow(cleanupBaseTime + 5000);
        await outbox.drainItems([originalItem.id]);
      }
      expect(context.mocks.resend.send).toHaveBeenCalledTimes(
        cleanupStatus === "failed" ? 3 : 0,
      );
      await expect(outbox.readItem(originalItem.id)).resolves.toMatchObject({
        status: cleanupStatus,
      });

      await accept(
        workflowClient().delete({
          headers: authHeaders(),
          params: { workflowId: scenario.workflowId },
        }),
        [204],
      );
      expect((await runs.readRun(scenario.actor, runId)).status).toBe(
        "completed",
      );

      mockNow(cleanupBaseTime + OUTBOX_TTL_MS + 60_000);
      await expect(outbox.cleanupExpiredItems([originalItem.id])).resolves.toBe(
        1,
      );
      const afterCleanup = await outbox.findSourceState({
        sourceRunId: runId,
        sourceWorkflowAutomationId: scenario.automationId,
      });
      expect(afterCleanup.items).toStrictEqual([]);
      expect(afterCleanup.claim).toStrictEqual(beforeDelete.claim);

      const lateRedrives = await Promise.all(
        Array.from({ length: 8 }, async () => {
          return await accept(
            executionClient().interruptResultEmailCallback({
              body: { run_id: runId },
            }),
            [200],
          );
        }),
      );
      expect(
        lateRedrives.every((response) => {
          return response.body.skipped;
        }),
      ).toBeTruthy();
      const finalSource = await outbox.findSourceState({
        sourceRunId: runId,
        sourceWorkflowAutomationId: scenario.automationId,
      });
      expect(finalSource).toStrictEqual({
        items: [],
        claim: beforeDelete.claim,
      });

      await accept(
        executionClient().dispatchCallbacks({
          body: { run_id: runId, status: "completed", dispatch_count: 1 },
        }),
        [200],
      );
      await expect(resultCallbackState(scenario, runId)).resolves.toMatchObject(
        [{ status: "delivered" }],
      );
      await expect(
        outbox.findSourceState({
          sourceRunId: runId,
          sourceWorkflowAutomationId: scenario.automationId,
        }),
      ).resolves.toStrictEqual({ items: [], claim: beforeDelete.claim });
    },
  );
});
