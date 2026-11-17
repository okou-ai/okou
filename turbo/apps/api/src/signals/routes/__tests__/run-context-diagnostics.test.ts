import { expect, onTestFinished, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { createBddApi } from "./helpers/api-bdd";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRunsApi } from "./helpers/api-bdd-runs";

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

  async function launch() {
    const run = await api.createThreadRun(actor, {
      agentId,
      prompt: "Business prompt retained independently of diagnostics",
    });
    onTestFinished(async () => {
      await api.requestCancelRun(actor, run.runId, [200]);
    });
    return run;
  }

  return { api, bdd, actor, agentId, snapshots, launch };
}

test("round-trips original launch variables and real secret names through diagnostic capture", async () => {
  const f = await diagnosticFixture();
  // This service credential exists only in firewall secrets, not environment
  // values. Give it the same value as an admitted variable to exercise masking
  // that the Runner's environment-only secret index cannot supply.
  const knownSecret = f.agentId;
  mockEnv("OKOU_DATA_ROUTER_URL", "https://data-router.example.test");
  mockEnv("OKOU_DATA_TOKEN", knownSecret);
  const run = await f.launch();
  const execution = await f.api.executionInput(run.runId);
  const response = await f.api.requestRunContext(f.actor, run.runId, [200]);
  if (response.status !== 200) {
    throw new Error("Expected captured run context");
  }

  expect(response.body).toMatchObject({
    prompt: execution.prompt,
    appendSystemPrompt: execution.appendSystemPrompt,
    vars: { OKOU_AGENT_ID: "***" },
    secretNames: expect.arrayContaining(["OKOU_TOKEN", "OKOU_DATA_TOKEN"]),
  });
  expect(execution.vars).toMatchObject({
    OKOU_AGENT_ID: f.agentId,
  });
  expect(JSON.stringify(response.body.vars)).not.toContain(knownSecret);
  expect(JSON.stringify(response.body)).not.toContain(
    execution.platformEnvironment.OKOU_TOKEN,
  );
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
