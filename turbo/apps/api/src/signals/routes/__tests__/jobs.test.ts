import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  jobsContract,
  type Job,
  type JobUpdate,
} from "@okouai/api-contracts/contracts/jobs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { jobsRoutes } from "../jobs";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";

const context = testContext();
const mocks = createRouteMocks(context);
const client = () => {
  return setupApp({ context, routes: jobsRoutes })(jobsContract);
};
function human(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}
async function fixture(secondary = false) {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const actor = bdd.user();
  const { defaultAgentId } = await bdd.readOnboardingStatus(actor);
  if (!actor.orgId || !defaultAgentId)
    throw new Error("Expected a default Agent");
  await bdd.completeOnboarding(actor);
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    { [FeatureSwitchKey.ProactiveJobs]: true },
  );
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runner = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const agentId = secondary
    ? (
        await bdd.createAgent(actor, {
          displayName: "Secondary",
          visibility: "private",
        })
      ).agentId
    : defaultAgentId;
  await runs.heartbeatRunner(runner);
  const run = await runs.createThreadRun(actor, {
    agentId,
    model: "claude-fable-5-1",
    prompt: "Create the Job explicitly entrusted by the user",
  });
  const claim = await runs.claimRunnerJob(run.runId);
  return {
    actor,
    agentId,
    headers: { authorization: `Bearer ${okouTokenFromClaim(claim)}` },
  };
}
async function create(headers: { readonly authorization: string }) {
  const body = {
    id: randomUUID(),
    title: "Research prospective customers",
    objective: "Deliver a verified shortlist of ten prospects",
    sourceReferences: [],
  };
  return (await accept(client().create({ headers, body }), [200])).body;
}
function patch(job: Job, changes: Partial<JobUpdate> = {}): JobUpdate {
  return {
    expected: { status: job.status, work: job.work },
    status: "active",
    work: job.work,
    ...changes,
  };
}
async function read(id: string, actor: ApiTestUser) {
  return (
    await accept(client().get({ headers: human(actor), params: { id } }), [200])
  ).body;
}

describe("Entrusted Jobs", () => {
  it("preserves a stable creation identity and rejects reuse for different delegation", async () => {
    const f = await fixture();
    const job = await create(f.headers);
    const body = {
      id: job.id.toUpperCase(),
      title: job.title,
      objective: job.objective,
      sourceReferences: job.sourceReferences,
    };
    const replay = await accept(
      client().create({ headers: f.headers, body }),
      [200],
    );
    expect(replay.body.id).toBe(job.id);
    await accept(
      client().create({
        headers: f.headers,
        body: { ...body, objective: "Different work" },
      }),
      [409],
    );
    const list = await accept(
      client().list({
        headers: human(f.actor),
        query: { filter: "all", limit: 100 },
      }),
      [200],
    );
    expect(
      list.body.jobs.map((value) => {
        return value.id;
      }),
    ).toEqual([job.id]);
  });

  it("keeps concurrent replies pending across a progress update based on older work", async () => {
    const f = await fixture();
    const job = await create(f.headers);
    const inputs = [randomUUID(), randomUUID()];
    const headers = human(f.actor);
    await Promise.all(
      inputs.map((id, index) => {
        return accept(
          client().input({
            headers,
            params: { id: job.id },
            body: { id, kind: "reply", text: `New requirement ${index}` },
          }),
          [200],
        );
      }),
    );
    const waiting = await accept(
      client().update({
        headers: f.headers,
        params: { id: job.id },
        body: patch(job, {
          status: "waiting_decision",
          work: {
            ...job.work,
            explanation: "Which region should I prioritize?",
          },
        }),
      }),
      [200],
    );
    expect(waiting.body.inputs).toHaveLength(2);
    expect(waiting.body.hasPendingInput).toBe(true);
    const runnable = await accept(
      client().list({ headers, query: { filter: "runnable", limit: 100 } }),
      [200],
    );
    expect(
      runnable.body.jobs.map((value) => {
        return value.id;
      }),
    ).toContain(job.id);
    const current = await read(job.id, f.actor);
    const next = await accept(
      client().update({
        headers: f.headers,
        params: { id: job.id },
        body: patch(current, {
          status: "waiting_decision",
          work: {
            ...current.work,
            processedInputIds: current.inputs.map((value) => {
              return value.id;
            }),
          },
        }),
      }),
      [200],
    );
    expect(next.body.hasPendingInput).toBe(false);
    await accept(
      client().update({
        headers: f.headers,
        params: { id: job.id },
        body: patch(current, {
          work: { ...current.work, processedInputIds: [current.inputs[1]!.id] },
        }),
      }),
      [409],
    );
  });

  it("deduplicates replies and rejects an input ID reused with different content", async () => {
    const f = await fixture();
    const job = await create(f.headers);
    const body = {
      id: randomUUID(),
      kind: "reply" as const,
      text: "Focus on the US market",
    };
    for (let index = 0; index < 2; index++)
      await accept(
        client().input({
          headers: human(f.actor),
          params: { id: job.id },
          body,
        }),
        [200],
      );
    await accept(
      client().input({
        headers: human(f.actor),
        params: { id: job.id },
        body: { ...body, text: "Focus on Europe instead" },
      }),
      [409],
    );
    expect((await read(job.id, f.actor)).inputs).toHaveLength(1);
  });

  it("acknowledges only the displayed Result and reevaluates completed replies without reopening automatically", async () => {
    const f = await fixture();
    const job = await create(f.headers);
    const first = {
      id: randomUUID(),
      text: "Ten verified prospects",
      references: [],
    };
    let current = (
      await accept(
        client().update({
          headers: f.headers,
          params: { id: job.id },
          body: patch(job, {
            status: "completed",
            work: { ...job.work, currentResultId: first.id },
            result: first,
          }),
        }),
        [200],
      )
    ).body;
    const second = {
      id: randomUUID(),
      text: "Updated verified shortlist",
      references: [],
    };
    current = (
      await accept(
        client().update({
          headers: f.headers,
          params: { id: job.id },
          body: patch(current, {
            status: "completed",
            work: { ...current.work, currentResultId: second.id },
            result: second,
          }),
        }),
        [200],
      )
    ).body;
    const oldReceipt = await accept(
      client().viewed({
        headers: human(f.actor),
        params: { id: job.id },
        body: { resultId: first.id },
      }),
      [200],
    );
    expect(oldReceipt.body.hasUnseenResult).toBe(true);
    const seen = await accept(
      client().viewed({
        headers: human(f.actor),
        params: { id: job.id },
        body: { resultId: second.id },
      }),
      [200],
    );
    expect(seen.body.status).toBe("completed");
    expect(seen.body.results).toHaveLength(2);
    const home = await accept(
      client().list({
        headers: human(f.actor),
        query: { filter: "home", limit: 100 },
      }),
      [200],
    );
    expect(home.body.jobs).toEqual([]);
    const history = await accept(
      client().list({
        headers: human(f.actor),
        query: { filter: "history", limit: 100 },
      }),
      [200],
    );
    expect(
      history.body.jobs.map((value) => {
        return value.id;
      }),
    ).toEqual([job.id]);
    const reply = await accept(
      client().input({
        headers: human(f.actor),
        params: { id: job.id },
        body: { id: randomUUID(), kind: "reply", text: "Thanks" },
      }),
      [200],
    );
    expect(reply.body.status).toBe("completed");
    expect(reply.body.hasPendingInput).toBe(true);
    const keptComplete = await accept(
      client().update({
        headers: f.headers,
        params: { id: job.id },
        body: patch(reply.body, {
          status: "completed",
          work: {
            ...reply.body.work,
            processedInputIds: reply.body.inputs.map((value) => {
              return value.id;
            }),
          },
        }),
      }),
      [200],
    );
    expect(keptComplete.body.status).toBe("completed");
    expect(keptComplete.body.hasPendingInput).toBe(false);
    expect(keptComplete.body.results).toHaveLength(2);
  });

  it("makes archive win over late agent completion and excludes pending input from runnable work", async () => {
    const f = await fixture();
    const job = await create(f.headers);
    await accept(
      client().input({
        headers: human(f.actor),
        params: { id: job.id },
        body: { id: randomUUID(), kind: "reply", text: "Extra context" },
      }),
      [200],
    );
    const result = { id: randomUUID(), text: "Work finished", references: [] };
    await Promise.all([
      accept(
        client().update({
          headers: f.headers,
          params: { id: job.id },
          body: patch(job, {
            status: "completed",
            work: { ...job.work, currentResultId: result.id },
            result,
          }),
        }),
        [200, 409],
      ),
      accept(
        client().archive({
          headers: human(f.actor),
          params: { id: job.id },
          body: {},
        }),
        [200],
      ),
    ]);
    expect((await read(job.id, f.actor)).status).toBe("archived");
    await accept(
      client().update({
        headers: f.headers,
        params: { id: job.id },
        body: patch(job),
      }),
      [409],
    );
    await accept(
      client().input({
        headers: human(f.actor),
        params: { id: job.id },
        body: { id: randomUUID(), kind: "reply", text: "Resume" },
      }),
      [409],
    );
    const runnable = await accept(
      client().list({
        headers: human(f.actor),
        query: { filter: "runnable", limit: 100 },
      }),
      [200],
    );
    expect(runnable.body.jobs).toEqual([]);
  });

  it("requires actual Agent-scoped permission and keeps user input routes unavailable to agents", async () => {
    const f = await fixture();
    const job = await create(f.headers);
    const request = {
      id: randomUUID(),
      agentId: f.agentId,
      connector: "github",
      permission: "issues:write",
      action: "Create the requested issue",
    };
    await accept(
      client().update({
        headers: f.headers,
        params: { id: job.id },
        body: patch(job, {
          status: "waiting_authorization",
          work: {
            ...job.work,
            explanation: "Allow GitHub issue creation",
            authorization: request,
          },
        }),
      }),
      [200],
    );
    const body = {
      id: randomUUID(),
      kind: "authorization" as const,
      requestId: request.id,
      outcome: "granted" as const,
      text: "",
    };
    await accept(
      client().input({ headers: human(f.actor), params: { id: job.id }, body }),
      [409],
    );
    await accept(
      client().input({ headers: f.headers, params: { id: job.id }, body }),
      [403],
    );
    expect((await read(job.id, f.actor)).inputs).toEqual([]);
    await accept(
      client().input({
        headers: human(f.actor),
        params: { id: job.id },
        body: { ...body, outcome: "declined" },
      }),
      [200],
    );
  });

  it("isolates owners and prevents non-primary Agents and disabled features from reading Jobs", async () => {
    const f = await fixture();
    const job = await create(f.headers);
    const bdd = createBddApi(context);
    const other = bdd.user();
    await bdd.readOnboardingStatus(other);
    if (!other.orgId) throw new Error("Expected another org");
    await updateFeatureSwitchesForUser(
      context,
      { ...other, orgId: other.orgId },
      { [FeatureSwitchKey.ProactiveJobs]: true },
    );
    await accept(
      client().get({ headers: human(other), params: { id: job.id } }),
      [404],
    );
    await updateFeatureSwitchesForUser(
      context,
      { ...f.actor, orgId: f.actor.orgId! },
      { [FeatureSwitchKey.ProactiveJobs]: false },
    );
    await accept(
      client().get({ headers: human(f.actor), params: { id: job.id } }),
      [403],
    );
  });

  it("does not issue Job write authority to a secondary Agent", async () => {
    const f = await fixture(true);
    await accept(
      client().create({
        headers: f.headers,
        body: {
          id: randomUUID(),
          title: "Unauthorized Job",
          objective: "Must not be created",
        },
      }),
      [403],
    );
  });
  it("orders waiting work and unseen Results before active Jobs across pages", async () => {
    const f = await fixture();
    const active = await create(f.headers);
    const waiting = await create(f.headers);
    const completed = await create(f.headers);
    await accept(
      client().update({
        headers: f.headers,
        params: { id: waiting.id },
        body: patch(waiting, {
          status: "waiting_decision",
          work: { ...waiting.work, explanation: "Choose a region" },
        }),
      }),
      [200],
    );
    const result = {
      id: randomUUID(),
      text: "Verified report",
      references: [],
    };
    await accept(
      client().update({
        headers: f.headers,
        params: { id: completed.id },
        body: patch(completed, {
          status: "completed",
          work: { ...completed.work, currentResultId: result.id },
          result,
        }),
      }),
      [200],
    );
    const first = await accept(
      client().list({
        headers: human(f.actor),
        query: { filter: "home", limit: 1 },
      }),
      [200],
    );
    expect(
      first.body.jobs.map((job) => {
        return job.id;
      }),
    ).toEqual([waiting.id]);
    const second = await accept(
      client().list({
        headers: human(f.actor),
        query: { filter: "home", limit: 1, after: waiting.id },
      }),
      [200],
    );
    expect(
      second.body.jobs.map((job) => {
        return job.id;
      }),
    ).toEqual([completed.id]);
    const third = await accept(
      client().list({
        headers: human(f.actor),
        query: { filter: "home", limit: 1, after: completed.id },
      }),
      [200],
    );
    expect(
      third.body.jobs.map((job) => {
        return job.id;
      }),
    ).toEqual([active.id]);
    expect(third.body.nextAfter).toBeNull();
  });

  it("retains authorization requests and rejects reusing an identity for a different action", async () => {
    const f = await fixture();
    const job = await create(f.headers);
    const request = {
      id: randomUUID(),
      agentId: f.agentId,
      connector: "github",
      permission: "issues:write",
      action: "Create the requested issue",
    };
    const first = (
      await accept(
        client().update({
          headers: f.headers,
          params: { id: job.id },
          body: patch(job, {
            status: "waiting_authorization",
            work: {
              ...job.work,
              explanation: "Allow issue creation",
              authorization: request,
            },
          }),
        }),
        [200],
      )
    ).body;
    expect(first.authorizationRequests).toEqual([request]);
    const replacement = {
      ...request,
      id: randomUUID(),
      action: "Update the requested issue",
    };
    const second = (
      await accept(
        client().update({
          headers: f.headers,
          params: { id: job.id },
          body: patch(first, {
            status: "waiting_authorization",
            work: { ...first.work, authorization: replacement },
          }),
        }),
        [200],
      )
    ).body;
    await accept(
      client().update({
        headers: f.headers,
        params: { id: job.id },
        body: patch(second, {
          status: "waiting_authorization",
          work: {
            ...second.work,
            authorization: { ...request, action: "A different action" },
          },
        }),
      }),
      [409],
    );
    expect((await read(job.id, f.actor)).authorizationRequests).toEqual([
      request,
      replacement,
    ]);
  });

  it("publishes one Result under concurrent retries and requires selecting that Result atomically", async () => {
    const f = await fixture();
    const job = await create(f.headers);
    const result = {
      id: randomUUID(),
      text: "Verified report",
      references: [],
    };
    await accept(
      client().update({
        headers: f.headers,
        params: { id: job.id },
        body: patch(job, { result }),
      }),
      [400],
    );
    const body = patch(job, {
      status: "completed",
      work: { ...job.work, currentResultId: result.id },
      result,
    });
    const outcomes = await Promise.all([
      client().update({ headers: f.headers, params: { id: job.id }, body }),
      client().update({ headers: f.headers, params: { id: job.id }, body }),
    ]);
    expect(
      outcomes
        .map((outcome) => {
          return outcome.status;
        })
        .sort(),
    ).toEqual([200, 409]);
    expect(
      (await read(job.id, f.actor)).results.map((value) => {
        return value.id;
      }),
    ).toEqual([result.id]);
  });
});
