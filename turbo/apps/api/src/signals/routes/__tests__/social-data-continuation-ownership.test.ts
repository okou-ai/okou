import { randomUUID } from "node:crypto";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { chatThreadUsageContract } from "@okouai/api-contracts/contracts/chat-threads";
import { socialDataContract } from "@okouai/api-contracts/contracts/social-data";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { billingStatusRoutes } from "../billing-status";
import { chatThreadUsageRoutes } from "../chat-threads-usage";
import { socialDataRoutes } from "../social-data";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createPublicBillingScenario } from "./helpers/public-billing-scenario";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const ROUTES = Object.freeze([
  ...socialDataRoutes,
  ...billingStatusRoutes,
  ...chatThreadUsageRoutes,
]);
const SEC_UID = "MS4wLjABAAAA_public_continuation_ownership";
const ENDPOINT = "/api/v1/douyin/app/v3/fetch_user_post_videos";
const REQUEST = {
  platform: "douyin",
  operation: "posts",
  url: `https://www.douyin.com/user/${SEC_UID}`,
  limit: 3,
} as const;

type Headers = { authorization: string };

function authenticate(actor: ApiTestUser): Headers {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

async function scenario() {
  const actor = createBddApi(context).user();
  const billing = createPublicBillingScenario(context);
  let restoreSetup: (() => void) | undefined;
  billing.releaseBeforeDrain(() => {
    restoreSetup?.();
  });
  await billing.run(() => {
    return createRunsApi(context).grantProEntitlement(actor, {
      run: billing.run,
      onExternalStateReady(restore) {
        restoreSetup = restore;
        billing.captureExternalState();
      },
    });
  });
  restoreSetup = undefined;
  mockEnv("OKOU_SOCIAL_MONID_API_KEY", "social-ownership-test-key");
  const app = setupApp({ context, routes: ROUTES });
  return {
    actor,
    run: billing.run,
    social: app(socialDataContract),
    usage: app(chatThreadUsageContract),
    async credits() {
      const response = await accept(
        app(billingStatusContract).get({ headers: authenticate(actor) }),
        [200],
      );
      return response.body.credits;
    },
  };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

/** Only Monid's HTTP boundary is controlled; the saved jobs and debits are real. */
function douyinPages(pending = false) {
  const pages = [
    { cursor: 0, count: 3, id: "701", nextCursor: 100, hasMore: true },
    { cursor: 100, count: 2, id: "702", nextCursor: 200, hasMore: false },
  ];
  const submissions: unknown[] = [];
  const receipts = new Map<
    string,
    { readonly index: number; readonly receipt: object }
  >();
  const completedPages = new Set<number>();
  server.use(
    http.post("https://api.monid.ai/v1/inspect", async ({ request }) => {
      await expect(request.json()).resolves.toStrictEqual({
        provider: "tikhub",
        endpoint: ENDPOINT,
      });
      return HttpResponse.json({
        provider: "tikhub",
        endpoint: ENDPOINT,
        input: {
          queryParams: {
            type: "object",
            properties: {
              sec_user_id: { type: "string" },
              max_cursor: { type: "integer" },
              count: { type: "integer" },
              sort_type: { type: "integer" },
              channel: { type: "string" },
            },
          },
        },
        price: { type: "PER_CALL", amount: { value: 0.001, currency: "USD" } },
      });
    }),
    http.post("https://api.monid.ai/v1/run", async ({ request }) => {
      const index = submissions.length;
      const page = pages[index];
      if (!page) {
        throw new Error("Unexpected additional paid Social page");
      }
      const body: unknown = await request.json();
      submissions.push(body);
      expect(body).toStrictEqual({
        provider: "tikhub",
        endpoint: ENDPOINT,
        input: {
          queryParams: {
            sec_user_id: SEC_UID,
            max_cursor: page.cursor,
            count: page.count,
            sort_type: 0,
            channel: "normal",
          },
        },
      });
      const runId = `social_${randomUUID()}`;
      const receipt = {
        runId,
        provider: "tikhub",
        endpoint: ENDPOINT,
        status: "COMPLETED",
        output: {
          code: 200,
          data: {
            status_code: 0,
            has_more: page.hasMore ? 1 : 0,
            max_cursor: page.nextCursor,
            aweme_list: [{ aweme_id: page.id, desc: `Public post ${page.id}` }],
          },
        },
        providerResponse: { httpStatus: 200 },
        billedUnits: 1,
        cost: { value: 0.001, currency: "USD", unit: "USD" },
      };
      receipts.set(runId, { index, receipt });
      return HttpResponse.json(
        pending
          ? { runId, provider: "tikhub", endpoint: ENDPOINT, status: "RUNNING" }
          : receipt,
        { status: pending ? 202 : 200 },
      );
    }),
    http.get("https://api.monid.ai/v1/runs/:runId", ({ params }) => {
      const entry = receipts.get(String(params.runId));
      if (!entry) {
        throw new Error("Unexpected Social provider receipt lookup");
      }
      return HttpResponse.json(
        !pending || completedPages.has(entry.index)
          ? entry.receipt
          : {
              runId: params.runId,
              provider: "tikhub",
              endpoint: ENDPOINT,
              status: "RUNNING",
            },
      );
    }),
  );
  return {
    submissions,
    completePage(index: number) {
      // The external provider publishes its receipt; recovery still uses GET.
      completedPages.add(index);
    },
  };
}

function get(
  setup: Scenario,
  jobId: string,
  headers = authenticate(setup.actor),
) {
  return accept(setup.social.get({ headers, params: { jobId } }), [200]);
}

async function completed(
  setup: Scenario,
  jobId: string,
  headers = authenticate(setup.actor),
) {
  await expect
    .poll(async () => {
      const response = await get(setup, jobId, headers);
      return {
        status: response.body.status,
        billing: response.body.billing.state,
      };
    })
    .toEqual({ status: "completed", billing: "settled" });
  return get(setup, jobId, headers);
}

function continuePage(
  setup: Scenario,
  jobId: string,
  requestId: string,
  headers = authenticate(setup.actor),
) {
  return accept(
    setup.social.continue({
      headers,
      params: { jobId },
      body: { requestId, maxCredits: 2 },
    }),
    [202, 409],
  );
}

describe("Social continuation admission and creation-Run ownership", () => {
  it("accepts one overlapping distinct-request-ID successor and recovers one provider page and debit", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const provider = douyinPages();
      const root = await accept(
        setup.social.create({
          headers: authenticate(setup.actor),
          body: { ...REQUEST, requestId: randomUUID() },
        }),
        [202],
      );
      await completed(setup, root.body.jobId);
      const before = await setup.credits();
      expect(provider.submissions).toHaveLength(1);

      const requestIds = [randomUUID(), randomUUID()] as const;
      // Both callers know only the settled source and their own request IDs.
      const results = await Promise.all(
        requestIds.map((requestId) => {
          return continuePage(setup, root.body.jobId, requestId);
        }),
      );
      expect(
        results
          .map((result) => {
            return result.status;
          })
          .sort(),
      ).toStrictEqual([202, 409]);
      const accepted = results.find((result) => {
        return result.status === 202;
      });
      const rejected = results.find((result) => {
        return result.status === 409;
      });
      if (accepted?.status !== 202 || rejected?.status !== 409) {
        throw new Error("Expected one accepted successor and one conflict");
      }
      expect(rejected.body.error.code).toBe(
        "SOCIAL_DATA_PAGE_ALREADY_CONTINUED",
      );
      expect(accepted.body.jobId).not.toBe(root.body.jobId);
      const child = await completed(setup, accepted.body.jobId);
      expect(child.body).toMatchObject({
        data: { items: [{ id: "702" }] },
        collection: {
          sourceJobId: root.body.jobId,
          itemsReturned: 1,
          cumulativeItemsReturned: 2,
          continuationAvailable: false,
        },
        billing: { state: "settled", creditsCharged: 2 },
      });
      expect(requestIds).toContain(child.body.requestId);
      const listed = await accept(
        setup.social.list({
          headers: authenticate(setup.actor),
          query: { limit: 20, includeExpanded: "true" },
        }),
        [200],
      );
      expect(
        listed.body.jobs
          .map((job) => {
            return job.jobId;
          })
          .sort(),
      ).toStrictEqual([root.body.jobId, accepted.body.jobId].sort());
      const replay = await continuePage(
        setup,
        root.body.jobId,
        child.body.requestId,
      );
      expect(replay.status).toBe(202);
      if (replay.status !== 202) {
        throw new Error(
          "Expected the accepted request to recover its successor",
        );
      }
      expect(replay.body.jobId).toBe(accepted.body.jobId);
      await get(setup, root.body.jobId);
      const recovered = await get(setup, replay.body.jobId);
      expect(recovered.body.billing).toStrictEqual(child.body.billing);
      expect(provider.submissions).toHaveLength(2);
      await expect(setup.credits()).resolves.toBe(before - 2);
    });
  });

  it("attributes parent and successor usage to their distinct genuine creation Runs, not the recovery caller", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");
      const restoreEnvironment = captureConnectorExternalState(context);
      const owner = publicRunOwner(context, setup.actor, {
        clockTime: now,
        restoreEnvironment,
      });
      await owner.run(() => {
        return createAuthDeviceSupportApi(context).initializePreferences(
          setup.actor,
        );
      });
      // scenario() already funds and onboards this actor. Reuse that public
      // entitlement rather than binding more Stripe customers to the same org.
      function claimRun() {
        return owner.run(async () => {
          const agent = await bdd.createAgent(setup.actor, {
            displayName: "Social creation Run",
            visibility: "private",
          });
          const run = await runs.createThreadRun(setup.actor, {
            agentId: agent.agentId,
            prompt: "Exercise Social creation-Run billing ownership",
            model: null,
          });
          await runs.heartbeatRunner(runnerGroup);
          const claim = await owner.claim(run.runId);
          const token = claim.platformEnvironment?.OKOU_TOKEN;
          if (!token) {
            throw new Error("Expected the real claim's Okou token");
          }
          return { ...run, token, sandboxToken: claim.sandboxToken };
        });
      }
      // Real chat sends, heartbeat and authenticated claims issue both tokens.
      const parentRun = await claimRun();
      const successorRun = await claimRun();
      expect(successorRun.runId).not.toBe(parentRun.runId);
      expect(successorRun.threadId).not.toBe(parentRun.threadId);
      const parentHeaders = { authorization: `Bearer ${parentRun.token}` };
      const successorHeaders = {
        authorization: `Bearer ${successorRun.token}`,
      };
      const provider = douyinPages(true);
      const before = await setup.credits();
      const root = await accept(
        setup.social.create({
          headers: parentHeaders,
          body: { ...REQUEST, requestId: randomUUID() },
        }),
        [202],
      );
      await expect
        .poll(async () => {
          return (await get(setup, root.body.jobId, successorHeaders)).body
            .status;
        })
        .toBe("running");
      provider.completePage(0);
      const first = await completed(setup, root.body.jobId, successorHeaders);
      expect(first.body.billing).toMatchObject({
        state: "settled",
        creditsCharged: 2,
      });

      const next = await continuePage(
        setup,
        root.body.jobId,
        randomUUID(),
        successorHeaders,
      );
      if (next.status !== 202) {
        throw new Error("Expected the second Run to create a successor");
      }
      await expect
        .poll(async () => {
          return (await get(setup, next.body.jobId, parentHeaders)).body.status;
        })
        .toBe("running");
      provider.completePage(1);
      const second = await completed(setup, next.body.jobId, parentHeaders);
      expect(second.body).toMatchObject({
        collection: { sourceJobId: root.body.jobId },
        billing: { state: "settled", creditsCharged: 2 },
      });

      function usage(run: typeof parentRun) {
        return accept(
          setup.usage.read({
            headers: authenticate(setup.actor),
            params: { id: run.threadId },
            body: { runIds: [run.runId] },
          }),
          [200],
        );
      }
      // The thread usage contract exposes finalized usage only after the Run
      // itself is terminal, even when its Social debit is already settled.
      for (const run of [parentRun, successorRun]) {
        expect((await usage(run)).body.runs).toStrictEqual([]);
        await owner.run(() => {
          return createWebhookCallbackApi(context).requestAgentComplete(
            {
              runId: run.runId,
              exitCode: 0,
              completion: {
                cliAgentType: "pi",
                cliAgentSessionId: run.threadId,
                cliAgentSessionHistoryDisposition: "native_only",
              },
            },
            { authorization: `Bearer ${run.sandboxToken}` },
            [200],
          );
        });
        expect((await runs.readRun(setup.actor, run.runId)).status).toBe(
          "completed",
        );
        const report = await usage(run);
        expect(report.body.runs).toStrictEqual([
          {
            runId: run.runId,
            usage: {
              version: 1,
              settledAt: expect.any(String),
              totalCredits: 2,
              breakdown: [
                {
                  kind: "social",
                  credits: 2,
                  providers: [{ provider: "monid/douyin", credits: 2 }],
                },
              ],
            },
          },
        ]);
      }
      // Replay under the other genuine Run cannot move or duplicate the debit.
      const replay = await continuePage(
        setup,
        root.body.jobId,
        second.body.requestId,
        parentHeaders,
      );
      expect(replay.status).toBe(202);
      if (replay.status !== 202) {
        throw new Error("Expected successor replay from the other Run");
      }
      expect(replay.body.jobId).toBe(next.body.jobId);
      await get(setup, next.body.jobId, parentHeaders);
      for (const run of [parentRun, successorRun]) {
        const report = await usage(run);
        expect(report.body.runs).toHaveLength(1);
        expect(report.body.runs[0]?.usage.totalCredits).toBe(2);
      }
      expect(provider.submissions).toHaveLength(2);
      await expect(setup.credits()).resolves.toBe(before - 4);
    });
  });
});
