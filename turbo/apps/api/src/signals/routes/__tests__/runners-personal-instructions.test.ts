import { publicRunOwner } from "./helpers/public-run-owner";
import {
  contentBundleKey,
  prepareContentBundle,
} from "@okouai/core/content-bundle";
import {
  SINGLE_AGENT_SEED_INSTRUCTIONS,
  SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE,
} from "@okouai/core/seed-instructions";
import { instructionsContract } from "@okouai/api-contracts/contracts/instructions";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { instructionsRoutes } from "../instructions";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicChatActor } from "./helpers/public-chat-actor";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { readClaimedContentBundle } from "./helpers/claimed-content-bundle";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const api = createRunsApi(context);
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const client = () => {
  return setupApp({ context, routes: instructionsRoutes })(
    instructionsContract,
  );
};
async function mode(actor: ApiTestUser, singleAgent: boolean) {
  if (!actor.orgId) {
    throw new Error("Expected org");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    { singleAgent },
  );
}
async function save(actor: ApiTestUser, content: string) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return await accept(client().update({ headers, body: { content } }), [200]);
}

describe("Captured personal Instructions in Runner claims", () => {
  it("uses latest personal content at claim and keeps the signed API mode across a live flag disable", async () => {
    const owned = await publicChatActor(context);
    owned.ownsFeatureSwitches();
    await owned.run(async () => {
      const s3 = installWorkflowVolumeS3Fixture(context);
      const { defaultAgentId } = await bdd.readOnboardingStatus(owned.actor);
      if (!defaultAgentId) {
        throw new Error("Expected default executor");
      }
      await bdd.updateAgentInstructions(
        owned.actor,
        defaultAgentId,
        "Shared legacy Instructions",
      );
      await mode(owned.actor, true);
      await save(owned.actor, "personal at admission");
      const queued = await api.createThreadRun(owned.actor, {
        agentId: defaultAgentId,
        prompt: "personal claim",
        model: "auto",
      });
      await save(owned.actor, "latest before claim");
      await mode(owned.actor, false);
      const { claim } = await owned.claimChatRun(
        owned.runnerGroup,
        queued.runId,
      );
      const selected = claim.contentBundles.instructions!;
      expect(
        readClaimedContentBundle(s3.objects, selected)
          .get("instructions.md")
          ?.toString(),
      ).toBe("latest before claim");
      const token = claim.platformEnvironment.OKOU_TOKEN!;
      const runHeaders = { authorization: `Bearer ${token}` };
      const saved = await accept(
        client().update({
          headers: runHeaders,
          body: { content: "edit for next Run" },
        }),
        [200],
      );
      expect(
        (await accept(client().get({ headers: runHeaders }), [200])).body,
      ).toMatchObject(saved.body);
      expect(
        readClaimedContentBundle(s3.objects, selected)
          .get("instructions.md")
          ?.toString(),
      ).toBe("latest before claim");
      await api.requestCancelRun(owned.actor, queued.runId, [200]);
      await accept(client().get({ headers: runHeaders }), [403]);
      const legacy = await api.createThreadRun(owned.actor, {
        agentId: defaultAgentId,
        prompt: "legacy after disable",
        model: "auto",
      });
      await mode(owned.actor, true);
      const next = await owned.claimChatRun(owned.runnerGroup, legacy.runId);
      expect(
        readClaimedContentBundle(
          s3.objects,
          next.claim.contentBundles.instructions!,
        )
          .get("instructions.md")
          ?.toString(),
      ).toBe("Shared legacy Instructions");
      await accept(
        client().get({
          headers: {
            authorization: `Bearer ${next.claim.platformEnvironment.OKOU_TOKEN!}`,
          },
        }),
        [403],
      );
    });
  });

  it("clears the native instruction input and preserves the explicit non-default legacy path", async () => {
    const owned = await publicChatActor(context);
    owned.ownsFeatureSwitches();
    await owned.run(async () => {
      const s3 = installWorkflowVolumeS3Fixture(context);
      const { defaultAgentId } = await bdd.readOnboardingStatus(owned.actor);
      if (!defaultAgentId) {
        throw new Error("Expected default executor");
      }
      await mode(owned.actor, true);
      await save(owned.actor, "old managed file");
      const queued = await api.createThreadRun(owned.actor, {
        agentId: defaultAgentId,
        prompt: "clear personal file",
        model: "auto",
      });
      await save(owned.actor, "");
      const { claim } = await owned.claimChatRun(
        owned.runnerGroup,
        queued.runId,
      );
      const files = readClaimedContentBundle(
        s3.objects,
        claim.contentBundles.instructions!,
      );
      expect([...files.keys()]).toStrictEqual(["instructions.md"]);
      expect(files.get("instructions.md")?.byteLength).toBe(0);
      await bdd.updateAgentInstructions(
        owned.actor,
        owned.agentId,
        "retained non-default",
      );
      const retained = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "legacy non-default",
        model: "auto",
      });
      const nonDefault = await owned.claimChatRun(
        owned.runnerGroup,
        retained.runId,
      );
      await accept(
        client().get({
          headers: {
            authorization: `Bearer ${nonDefault.claim.platformEnvironment.OKOU_TOKEN!}`,
          },
        }),
        [403],
      );
      expect(
        readClaimedContentBundle(
          s3.objects,
          nonDefault.claim.contentBundles.instructions!,
        )
          .get("instructions.md")
          ?.toString(),
      ).toBe("retained non-default");
    });
  });
  it("uses the default until the first save and isolates two members on the same default executor", async () => {
    const owned = await publicChatActor(context);
    owned.ownsFeatureSwitches();
    await owned.run(async () => {
      // Deployments publish the default before serving.
      const { archive } = await prepareContentBundle([
        {
          path: "instructions.md",
          content: Buffer.from(SINGLE_AGENT_SEED_INSTRUCTIONS, "utf8"),
        },
      ]);
      const s3 = installWorkflowVolumeS3Fixture(
        context,
        new Map([
          [
            contentBundleKey(SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE.sha256),
            archive,
          ],
        ]),
      );
      const { defaultAgentId } = await bdd.readOnboardingStatus(owned.actor);
      if (!defaultAgentId) {
        throw new Error("Expected default executor");
      }
      await mode(owned.actor, true);
      const first = await api.createThreadRun(owned.actor, {
        agentId: defaultAgentId,
        prompt: "first personal use",
        model: "auto",
      });
      const initial = await owned.claimChatRun(owned.runnerGroup, first.runId);
      expect(
        readClaimedContentBundle(
          s3.objects,
          initial.claim.contentBundles.instructions!,
        )
          .get("instructions.md")
          ?.toString(),
      ).toBe(SINGLE_AGENT_SEED_INSTRUCTIONS);
      const bob = bdd.user({ orgId: owned.actor.orgId, orgRole: "org:member" });
      const bobOwner = publicRunOwner(context, bob, {
        continueAcceptedOperations: true,
      });
      await bobOwner.run(async () => {
        await bdd.completeOnboarding(bob);
        await api.ensurePersonalSubscriptionModel(bob);
        await mode(bob, true);
        await save(owned.actor, "Alice only");
        await save(bob, "Bob only");
        const aliceRun = await api.createThreadRun(owned.actor, {
          agentId: defaultAgentId,
          prompt: "Alice",
          model: "auto",
        });
        const bobRun = await api.createThreadRun(bob, {
          agentId: defaultAgentId,
          prompt: "Bob",
          model: "auto",
        });
        const aliceClaim = await owned.claimChatRun(
          owned.runnerGroup,
          aliceRun.runId,
        );
        const bobClaim = await api.claimRunnerJob(bobRun.runId);
        bobOwner.rememberClaim(bobRun.runId, bobClaim.sandboxToken);
        expect(
          readClaimedContentBundle(
            s3.objects,
            aliceClaim.claim.contentBundles.instructions!,
          )
            .get("instructions.md")
            ?.toString(),
        ).toBe("Alice only");
        expect(
          readClaimedContentBundle(
            s3.objects,
            bobClaim.contentBundles.instructions!,
          )
            .get("instructions.md")
            ?.toString(),
        ).toBe("Bob only");
        const bobSaved = await accept(
          client().get({
            headers: {
              authorization: `Bearer ${bobClaim.platformEnvironment.OKOU_TOKEN!}`,
            },
          }),
          [200],
        );
        expect(bobSaved.body).toMatchObject({
          userId: bob.userId,
          content: "Bob only",
        });
      });
    });
  });
});
