import { randomUUID } from "node:crypto";
import { expect, onTestFinished, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

const context = testContext();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function diagnosticFixture() {
  const api = createRunsApi(context);
  const bdd = createBddApi(context);
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  await api.configureRunnerGroup();
  const actor = bdd.user();
  await api.grantProEntitlement(actor);
  await api.ensurePersonalSubscriptionModel(actor);
  const { agentId } = await bdd.createAgent(actor, {
    displayName: "Snapshot diagnostics",
    visibility: "private",
  });

  // Replay the diagnostic provider's captured documents through the read API,
  // rather than asserting incidental telemetry calls or privately seeding Runs.
  const snapshots = new Map<string, Record<string, unknown>>();
  context.mocks.axiom.ingest.mockImplementation((dataset, events) => {
    if (dataset === "run-context" && Array.isArray(events)) {
      for (const event of events) {
        if (isRecord(event) && typeof event.runId === "string") {
          snapshots.set(event.runId, event);
        }
      }
    }
    return true;
  });
  context.mocks.axiom.query.mockImplementation((apl) => {
    const runId =
      typeof apl === "string" ? /runId == "([^"]+)"/.exec(apl)?.[1] : undefined;
    const snapshot = runId ? snapshots.get(runId) : undefined;
    return Promise.resolve(snapshot ? [snapshot] : []);
  });

  async function launch(previewBypass?: string) {
    const prompt = "Business prompt retained independently of diagnostics";
    let run: { readonly runId: string; readonly threadId: string };
    if (previewBypass) {
      const chat = createChatFilesBddApi(context);
      const clientEventId = randomUUID();
      const sent = await chat.requestSendEvent(
        actor,
        { prompt, clientEventId, model: "claude-fable-5-1" },
        [201],
        { extraHeaders: { "x-vercel-protection-bypass": previewBypass } },
      );
      if (sent.status !== 201) {
        throw new Error("Expected the authorized Preview send to be accepted");
      }
      await flushWaitUntilForTest();
      mockEnv("ENV", "development");
      const { events } = await chat.listThreadEvents(actor, sent.body.threadId);
      const runId = events.find((event) => {
        return event.revokesEventId === clientEventId;
      })?.runId;
      if (!runId) {
        throw new Error("Expected the authorized Preview send to launch a Run");
      }
      run = { runId, threadId: sent.body.threadId };
    } else {
      run = await api.createThreadRun(actor, { prompt });
    }
    onTestFinished(async () => {
      await api.requestCancelRun(actor, run.runId, [200]);
    });
    return run;
  }

  return { api, bdd, actor, agentId, snapshots, launch };
}

test.each(["data router", "Preview"])(
  "masks API-only %s credentials in captured diagnostics",
  async (source) => {
    const f = await diagnosticFixture();
    // This service credential stays at the API. Give it the same value as an
    // admitted variable to exercise masking without a Runner secret-value index.
    const knownSecret = "https://diagnostic.example.test";
    mockEnv("APP_URL", knownSecret);
    const secretName =
      source === "data router"
        ? "OKOU_DATA_TOKEN"
        : "VERCEL_AUTOMATION_BYPASS_SECRET";
    if (source === "data router") {
      mockEnv("OKOU_DATA_ROUTER_URL", "https://data-router.example.test");
    } else {
      mockEnv("ENV", "preview");
    }
    mockEnv(secretName, knownSecret);
    const run = await f.launch(source === "Preview" ? knownSecret : undefined);
    const execution = await f.api.executionInput(run.runId);
    const response = await f.api.requestRunContext(f.actor, run.runId, [200]);
    if (response.status !== 200) {
      throw new Error("Expected captured run context");
    }

    expect(response.body).toMatchObject({
      prompt: execution.prompt,
      appendSystemPrompt: execution.appendSystemPrompt,
      environment: { OKOU_APP_URL: "***" },
      secretNames: expect.arrayContaining(["OKOU_TOKEN", secretName]),
    });
    expect(execution.platformEnvironment).toMatchObject({
      OKOU_APP_URL: knownSecret,
    });
    expect(JSON.stringify(response.body.environment)).not.toContain(
      knownSecret,
    );
    expect(JSON.stringify(response.body)).not.toContain(
      execution.platformEnvironment.OKOU_TOKEN,
    );
  },
);

test("reads captured diagnostics through uppercase Run UUID paths", async () => {
  const f = await diagnosticFixture();
  const run = await f.launch();
  const captured = f.snapshots.get(run.runId);
  if (!captured) {
    throw new Error("Expected the provider to receive diagnostic capture");
  }
  const appendSystemPrompt = "Captured instructions for the admitted Run";
  f.snapshots.set(run.runId, { ...captured, appendSystemPrompt });
  const requestedRunId = run.runId.toUpperCase();
  const reads = createRunReadsApi(context);

  expect(
    (await reads.requestReadLogById(f.actor, requestedRunId, [200])).body,
  ).toMatchObject({ id: run.runId, appendSystemPrompt });
  expect(
    (await f.api.requestRunContext(f.actor, requestedRunId, [200])).body,
  ).toMatchObject({
    prompt: "Business prompt retained independently of diagnostics",
    appendSystemPrompt,
    vars: {},
  });
});

test("distinguishes captured empty values from historically unavailable diagnostic fields", async () => {
  const f = await diagnosticFixture();
  const run = await f.launch();
  const captured = f.snapshots.get(run.runId);
  if (!captured) {
    throw new Error("Expected the provider to receive diagnostic capture");
  }
  const read = () => {
    return f.api.requestRunContext(f.actor, run.runId, [200]);
  };
  f.snapshots.set(run.runId, {
    ...captured,
    prompt: "",
    appendSystemPrompt: "Captured instructions",
    varEntries: [],
  });
  expect((await read()).body).toMatchObject({
    prompt: "",
    appendSystemPrompt: "Captured instructions",
    vars: {},
  });

  for (const varEntries of [undefined, null]) {
    f.snapshots.set(run.runId, {
      ...captured,
      prompt: "Historical captured prompt",
      varEntries,
    });
    expect((await read()).body).toMatchObject({
      prompt: "Historical captured prompt",
      vars: null,
    });
  }

  // A missing required observation is unavailable, not a fabricated empty
  // prompt or a value fetched from the business row.
  f.snapshots.set(run.runId, { ...captured, prompt: undefined });
  await f.api.requestRunContext(f.actor, run.runId, [404]);
  f.snapshots.delete(run.runId);
  await f.api.requestRunContext(f.actor, run.runId, [404]);
});

test("keeps ownership and business reads independent of unavailable diagnostic storage", async () => {
  const f = await diagnosticFixture();
  const run = await f.launch();
  const reads = createRunReadsApi(context);
  context.mocks.axiom.query.mockRejectedValue(
    new Error("Diagnostic storage is unavailable"),
  );

  const member = f.bdd.user({ orgId: f.actor.orgId, orgRole: "org:member" });
  const outsider = f.bdd.user();
  await f.api.requestRunContext(member, run.runId, [404]);
  await f.api.requestRunContext(outsider, run.runId, [404]);
  await reads.requestReadLogById(member, run.runId, [404]);

  await expect(f.api.readRun(f.actor, run.runId)).resolves.toMatchObject({
    runId: run.runId,
    status: "running",
    prompt: "Business prompt retained independently of diagnostics",
  });
  expect(
    (await reads.requestReadLogById(f.actor, run.runId, [200])).body,
  ).toMatchObject({
    id: run.runId,
    framework: "claude-code",
    appendSystemPrompt: null,
  });
  await expect(
    reads.rawApiRequest(f.actor, `/api/runs/${run.runId}/context`),
  ).resolves.toMatchObject({
    status: 500,
  });
});
