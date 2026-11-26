import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { describe, expect, it } from "vitest";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { feedContract } from "@okouai/api-contracts/contracts/feed";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { proactiveSuggestionsRoutes } from "../proactive-preferences";
import { feedRoutes } from "../feed";
import { createBddApi } from "./helpers/api-bdd";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);
const routes = Object.freeze([
  ...morningBriefPreferenceRoutes,
  ...proactiveSuggestionsRoutes,
  ...feedRoutes,
]);
const app = setupApp({ context, routes });

function preferenceClient(
  contract:
    typeof morningBriefPreferenceContract | typeof proactiveSuggestionsContract,
) {
  const client = app(contract);
  return {
    get: async (args: { headers: { authorization: string } }) => {
      return await client.get(args);
    },
    update: async (args: {
      headers: { authorization: string };
      body: { enabled: boolean };
    }) => {
      return contract === proactiveSuggestionsContract
        ? await app(proactiveSuggestionsContract).updateWithFeed(args)
        : await client.update(args);
    },
  };
}

async function preferenceRun() {
  const owned = await publicChatActor(context);
  return await owned.run(async () => {
    const { actor } = owned;
    await bdd.provisionWorkspace(actor);
    if (!actor.orgId) {
      throw new Error("Expected a workspace member");
    }
    await bdd.completeOnboarding(actor, { timezone: "UTC" });
    const sent = await owned.sendChatRun(actor, {
      prompt: "Manage my Proactive settings",
    });
    const { execution, sandboxHeaders } = await owned.runExecution(sent.runId);
    const token = execution.platformEnvironment.OKOU_TOKEN;
    if (!token) {
      throw new Error("Expected an execution token");
    }
    return {
      owned,
      runId: sent.runId,
      sandboxHeaders,
      actor: { ...actor, orgId: actor.orgId },
      headers: { authorization: `Bearer ${token}` },
    };
  });
}

describe("Proactive CLI preferences", () => {
  it("lets the primary Run control built-in preferences and delivery", async () => {
    const { owned, actor, headers } = await preferenceRun();
    installWorkflowVolumeS3Fixture(context);
    await owned.run(async () => {
      for (const contract of [
        morningBriefPreferenceContract,
        proactiveSuggestionsContract,
      ]) {
        const client = preferenceClient(contract);
        const initial = await accept(client.get({ headers }), [200]);
        expect(initial.body.enabled).toBeFalsy();
        for (const enabled of [true, false, true]) {
          const saved = await accept(
            client.update({ headers, body: { enabled } }),
            [200],
          );
          expect(saved.body).toMatchObject({
            enabled,
            status: enabled ? "enabled" : "paused",
            unavailableReason: null,
          });
          mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
          const session = { authorization: "Bearer clerk-session" };
          const read = await accept(client.get({ headers: session }), [200]);
          expect(read.body).toStrictEqual(saved.body);
          if (contract === proactiveSuggestionsContract) {
            const sources = await accept(
              app(feedContract).sources({ headers: session }),
              [200],
            );
            expect(sources.body).toMatchObject({
              suggestions: enabled,
              offers: true,
              whatsNew: true,
              systemUpdates: true,
            });
          }
        }
      }
      const feed = app(feedContract);
      // Source preferences stay editable while automatic Suggestions are paused.
      await accept(
        app(proactiveSuggestionsContract).updateWithFeed({
          headers,
          body: { enabled: false },
        }),
        [200],
      );
      for (const source of ["whatsNew", "offers", "systemUpdates"] as const) {
        const before = await accept(feed.sources({ headers }), [200]);
        for (const enabled of [false, true]) {
          const saved = await accept(
            feed.updateSources({ headers, body: { [source]: enabled } }),
            [200],
          );
          expect(saved.body).toStrictEqual({
            ...before.body,
            [source]: enabled,
          });
          mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
          const read = await accept(
            feed.sources({
              headers: { authorization: "Bearer clerk-session" },
            }),
            [200],
          );
          expect(read.body).toStrictEqual(saved.body);
        }
      }
    });
  });

  it("rejects preference access from a finished personal Run", async () => {
    const { owned, runId, headers, sandboxHeaders } = await preferenceRun();
    await owned.run(async () => {
      await createChatEventsFixture(context).failChatRun(
        runId,
        sandboxHeaders,
        "Finish the preference Run",
      );
      await flushWaitUntilForTest();
      for (const contract of [
        morningBriefPreferenceContract,
        proactiveSuggestionsContract,
      ]) {
        const client = preferenceClient(contract);
        const denied = await accept(client.get({ headers }), [403]);
        expect(denied.body.error.code).toBe("FORBIDDEN");
        await accept(
          client.update({ headers, body: { enabled: true } }),
          [403],
        );
      }
      await accept(app(feedContract).sources({ headers }), [403]);
      await accept(
        app(feedContract).updateSources({ headers, body: { offers: false } }),
        [403],
      );
    });
  });
});
