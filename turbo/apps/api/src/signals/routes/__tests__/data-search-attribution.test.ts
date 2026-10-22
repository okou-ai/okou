import { randomUUID } from "node:crypto";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { chatThreadUsageContract } from "@okouai/api-contracts/contracts/chat-threads";
import { dataSearchContract } from "@okouai/api-contracts/contracts/data-search";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { billingStatusRoutes } from "../billing-status";
import { chatThreadUsageRoutes } from "../chat-threads-usage";
import { dataSearchRoutes } from "../data-search";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createPublicBillingScenario } from "./helpers/public-billing-scenario";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

function authenticate(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

/** A pending paid receipt controlled exclusively at Monid's HTTP boundary. */
function delayedProfile() {
  const runId = `data_${randomUUID()}`;
  let completed = false;
  const observed = { submissions: 0, reads: 0 };
  const receipt = () => {
    return {
      runId,
      provider: "apollo",
      endpoint: "/people/match",
      status: completed ? "COMPLETED" : "RUNNING",
      ...(completed
        ? {
            providerResponse: { httpStatus: 200 },
            output: {
              person: { id: "profile-attribution", name: "Alex Jones" },
            },
            billing: {
              actualCost: {
                value: 26_000,
                currency: "USD",
                unit: "MICRO_DOLLAR",
              },
            },
          }
        : {}),
    };
  };
  server.use(
    http.post("https://api.monid.ai/v1/inspect", () => {
      return HttpResponse.json({
        provider: "apollo",
        endpoint: "/people/match",
        input: {
          queryParams: {
            type: "object",
            properties: {
              id: { type: "string" },
              linkedin_url: { type: "string" },
              name: { type: "string" },
              domain: { type: "string" },
              reveal_personal_emails: { type: "boolean" },
              reveal_phone_number: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        price: {
          type: "PER_CALL",
          amount: { value: 0.026, currency: "USD" },
        },
      });
    }),
    http.post("https://api.monid.ai/v1/run", () => {
      observed.submissions += 1;
      return HttpResponse.json(receipt());
    }),
    http.get(`https://api.monid.ai/v1/runs/${runId}`, () => {
      observed.reads += 1;
      return HttpResponse.json(receipt());
    }),
  );
  return {
    observed,
    complete() {
      completed = true;
    },
  };
}

describe("Data Search delayed receipt attribution", () => {
  it("bills the completed creation Run once when a later user read settles its paid job", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user({ orgId: createUniqueStaffOrgIdFixture() });
    const billing = createPublicBillingScenario(context);
    let restoreSetup: (() => void) | undefined;
    billing.releaseBeforeDrain(() => {
      restoreSetup?.();
    });
    await billing.run(() => {
      return runs.grantProEntitlement(actor, {
        run: billing.run,
        onExternalStateReady(restore) {
          restoreSetup = restore;
          billing.captureExternalState();
        },
      });
    });
    restoreSetup = undefined;

    await billing.run(async () => {
      mockEnv("OKOU_SOCIAL_MONID_API_KEY", "data-attribution-monid-key");
      mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      const owner = publicRunOwner(context, actor, {
        clockTime: now,
        restoreEnvironment: captureConnectorExternalState(context),
      });
      await owner.run(() => {
        return createAuthDeviceSupportApi(context).initializePreferences(actor);
      });
      const app = setupApp({
        context,
        routes: [
          ...dataSearchRoutes,
          ...billingStatusRoutes,
          ...chatThreadUsageRoutes,
        ],
      });
      const data = app(dataSearchContract);
      async function credits() {
        const response = await accept(
          app(billingStatusContract).get({ headers: authenticate(actor) }),
          [200],
        );
        return response.body.credits;
      }
      function claimRun() {
        return owner.run(async () => {
          const agent = await bdd.createAgent(actor, {
            displayName: "Data attribution Run",
            visibility: "private",
          });
          const run = await runs.createThreadRun(actor, {
            agentId: agent.agentId,
            prompt: "Enrich a professional profile",
            model: null,
          });
          await runs.heartbeatRunner(runnerGroup);
          const claim = await owner.claim(run.runId);
          const token = claim.platformEnvironment?.OKOU_TOKEN;
          if (!token) {
            throw new Error("Expected the real Runner claim's Okou token");
          }
          return { ...run, token, sandboxToken: claim.sandboxToken };
        });
      }
      async function complete(run: Awaited<ReturnType<typeof claimRun>>) {
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
        await flushWaitUntilForTest();
        const detail = await createRunReadsApi(context).requestReadLogById(
          actor,
          run.runId,
          [200],
        );
        expect(detail.body.status).toBe("completed");
      }
      function usage(run: Awaited<ReturnType<typeof claimRun>>) {
        return accept(
          app(chatThreadUsageContract).read({
            headers: authenticate(actor),
            params: { id: run.threadId },
            body: { runIds: [run.runId] },
          }),
          [200],
        );
      }

      const origin = await claimRun();
      const provider = delayedProfile();
      const before = await credits();
      // A genuine claim token must carry both search and enrichment grants.
      // No token signing or fabricated run context is involved in admission.
      const created = await accept(
        data.create({
          headers: { authorization: `Bearer ${origin.token}` },
          body: {
            capability: "people.enrich",
            input: { name: "Alex Jones", domain: "business.test" },
            limit: 1,
            maxCredits: 100,
            requestId: randomUUID(),
          },
        }),
        [202],
      );
      await flushWaitUntilForTest();
      function readJob() {
        return accept(
          data.get({
            headers: authenticate(actor),
            params: { jobId: created.body.jobId },
          }),
          [200],
        );
      }
      expect((await readJob()).body.status).toBe("running");
      await complete(origin);
      expect((await usage(origin)).body.runs).toStrictEqual([]);
      // A subsequent real Run cannot become the owner of the delayed debit.
      const later = await claimRun();
      expect(later.runId).not.toBe(origin.runId);
      await complete(later);
      provider.complete();
      await readJob();
      await flushWaitUntilForTest();
      const settled = await readJob();
      expect(settled.body).toMatchObject({
        status: "completed",
        billing: { state: "settled", creditsCharged: 33 },
      });
      expect(provider.observed.submissions).toBe(1);
      expect(provider.observed.reads).toBeGreaterThan(0);
      for (let read = 0; read < 2; read += 1) {
        expect((await readJob()).body.billing).toStrictEqual(
          settled.body.billing,
        );
        const originUsage = await usage(origin);
        expect(originUsage.body.runs).toStrictEqual([
          {
            runId: origin.runId,
            usage: {
              version: 1,
              settledAt: expect.any(String),
              totalCredits: 33,
              breakdown: [
                {
                  kind: "data-search",
                  credits: 33,
                  providers: [{ provider: "monid/apollo", credits: 33 }],
                },
              ],
            },
          },
        ]);
        const laterUsage = await usage(later);
        // Runs with no usage receipts have no finalized usage row.
        expect(laterUsage.body.runs).toStrictEqual([]);
        await expect(credits()).resolves.toBe(before - 33);
      }
      expect(provider.observed.submissions).toBe(1);
    });
  });
});
