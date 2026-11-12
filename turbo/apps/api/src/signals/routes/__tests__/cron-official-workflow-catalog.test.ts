import {
  cronExecuteWorkflowAutomationsContract,
  cronOfficialWorkflowCatalogContract,
} from "@okouai/api-contracts/contracts/cron";
import { withMockNowForTest } from "../../../lib/time";
import { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";
import { expect, test } from "vitest";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { proactiveLearningContract } from "@okouai/api-contracts/contracts/proactive-nightly";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
  type WorkflowFileEntry,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  proactiveSuggestionsRoutes,
  proactiveLearningRoutes,
} from "../proactive-preferences";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { readClaimedContentBundle } from "./helpers/claimed-content-bundle";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { cronOfficialWorkflowCatalogRoutes } from "../cron-official-workflow-catalog";

const context = testContext();

function expectScopeGuidance(
  instruction: string | null | undefined,
  learning: boolean,
) {
  if (learning) {
    expect(instruction).toContain(
      "changes to personal Instructions or shared Agent instructions",
    );
    expect(instruction).toContain(
      "Never override a higher-priority framework write restriction",
    );
  } else {
    expect(instruction).toContain("okou chat list --help");
    expect(instruction).not.toContain("--all-agents");
  }
}

function expectPublishingReference(
  files: ReadonlyMap<string, Buffer>,
  fileContents: readonly WorkflowFileEntry[] | null,
  learning: boolean,
) {
  if (learning) {
    return;
  }
  const reference = fileContents?.find((file) => {
    return file.path === "references/suggestions.md";
  });
  if (!reference) {
    throw new Error("Expected the suggestion publishing reference");
  }
  expect(files.get(reference.path)?.toString()).toBe(reference.content);
}

test("requires authentication to publish the Official Workflow catalog", async () => {
  mockEnv("CRON_SECRET", "official-workflow-catalog-cron-secret");
  const app = setupApp({
    context,
    routes: cronOfficialWorkflowCatalogRoutes,
  });
  const unauthorized = await accept(
    app(cronOfficialWorkflowCatalogContract).sync({}),
    [401],
  );
  expect(unauthorized.status).toBe(401);
});

const scenarios = [
  { kind: "suggestions", failUpload: false, suggestionsEnabled: true },
  { kind: "suggestions", failUpload: true, suggestionsEnabled: true },
  { kind: "learning", failUpload: false, suggestionsEnabled: true },
  { kind: "morning-brief", failUpload: false, suggestionsEnabled: true },
  { kind: "morning-brief", failUpload: false, suggestionsEnabled: false },
].map((scenario) => {
  const learning = scenario.kind === "learning";
  const morningBrief = scenario.kind === "morning-brief";
  return {
    ...scenario,
    learning,
    morningBrief,
    needsTimezone: learning || morningBrief,
    curatesSuggestions: !learning && scenario.suggestionsEnabled,
    curatesMorningBrief: morningBrief && scenario.suggestionsEnabled,
    definitionName: learning
      ? "proactive-learning"
      : morningBrief
        ? scenario.suggestionsEnabled
          ? "internal-test-morning-brief"
          : "morning-brief"
        : "agent-suggestions",
    heading: learning
      ? "# Proactive Learning"
      : morningBrief
        ? "# Morning Brief"
        : "# Proactive Suggestions",
    preferenceContract: learning
      ? proactiveLearningContract
      : morningBrief
        ? morningBriefPreferenceContract
        : proactiveSuggestionsContract,
  };
});

test.each(scenarios)(
  "publishes idempotently and runs $kind on schedule (upload failure: $failUpload, suggestions: $suggestionsEnabled)",
  async ({
    failUpload,
    learning,
    curatesMorningBrief,
    needsTimezone,
    curatesSuggestions,
    definitionName,
    heading,
    preferenceContract,
  }) => {
    mockEnv("CRON_SECRET", "official-workflow-catalog-cron-secret");
    const app = await setupApp({
      context,
      isolatePg: true,
      routes: [
        ...cronOfficialWorkflowCatalogRoutes,
        ...cronExecuteWorkflowAutomationsRoutes,
        ...proactiveSuggestionsRoutes,
        ...proactiveLearningRoutes,
        ...morningBriefPreferenceRoutes,
        ...workflowAutomationsRoutes,
        ...workflowsRoutes,
      ],
    });
    const owned = await publicChatActor(context);
    const fixture = createChatEventsFixture(context);
    const s3 = installWorkflowVolumeS3Fixture(context);
    const cronHeaders = {
      authorization: "Bearer official-workflow-catalog-cron-secret",
    };
    if (failUpload) {
      context.mocks.s3.send.mockRejectedValueOnce(
        new Error("S3 publication unavailable"),
      );
      const rejected = await owned.run(() => {
        return accept(
          app(cronOfficialWorkflowCatalogContract).sync({
            headers: cronHeaders,
          }),
          [200],
        );
      });
      expect(rejected.body).toMatchObject({
        outcome: "rejected",
        releaseId: null,
        diagnostics: [{ code: "artifact-preparation-failed" }],
      });
    }
    const published = await owned.run(() => {
      return accept(
        app(cronOfficialWorkflowCatalogContract).sync({ headers: cronHeaders }),
        [200],
      );
    });
    expect(published.body).toMatchObject({
      outcome: "accepted",
      diagnostics: [],
    });
    const repeated = await owned.run(() => {
      return accept(
        app(cronOfficialWorkflowCatalogContract).sync({ headers: cronHeaders }),
        [200],
      );
    });
    expect(repeated.body).toStrictEqual({
      outcome: "unchanged",
      releaseId: published.body.releaseId,
      diagnostics: [],
    });
    const actor = owned.actor;
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization owner");
    }
    owned.ownsFeatureSwitches();
    await owned.run(() => {
      return updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.AgentSuggestion]: true,
          [FeatureSwitchKey.ProactiveLearning]: learning,
        },
      );
    });
    if (needsTimezone) {
      await owned.run(() => {
        return fixture.bdd.completeOnboarding(actor, {
          timezone: "Asia/Shanghai",
        });
      });
    }
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
    const headers = { authorization: "Bearer clerk-session" };
    if (curatesMorningBrief) {
      await owned.run(() => {
        return accept(
          app(proactiveSuggestionsContract).update({
            headers,
            body: { enabled: true },
          }),
          [200],
        );
      });
    }
    const enabled = await owned.run(() => {
      const request = app(preferenceContract).update({
        headers,
        body: { enabled: true },
      });
      return accept<Awaited<typeof request>, 200>(request, [200]);
    });
    expect(enabled.body).toMatchObject({ enabled: true, status: "enabled" });
    const workflows = await owned.run(() => {
      return accept(
        app(workflowsCollectionContract).list({ headers, query: {} }),
        [200],
      );
    });
    const workflow = workflows.body.find((item) => {
      return item.official?.definitionName === definitionName;
    });
    if (!workflow) {
      throw new Error("Expected the Official workflow installation");
    }
    const detail = await owned.run(() => {
      return accept(
        app(workflowsDetailContract).get({
          headers,
          params: { workflowId: workflow.id },
        }),
        [200],
      );
    });
    expect(detail.body.instruction).toContain(heading);
    expectScopeGuidance(detail.body.instruction, learning);
    expect(detail.body.fileContents).toStrictEqual(expect.any(Array));
    const automations = await owned.run(() => {
      return accept(
        app(workflowAutomationsContract).list({
          headers,
          params: { workflowId: workflow.id },
        }),
        [200],
      );
    });
    const automation = automations.body[0];
    if (!automation) {
      throw new Error("Expected the Official workflow automation");
    }
    if (!automation.nextRunAt) {
      throw new Error("Expected the next Official workflow schedule");
    }
    if (learning) {
      if (
        automation.kind !== "schedule" ||
        automation.schedule.type !== "cron"
      ) {
        throw new Error("Expected the Learning cron schedule");
      }
      expect(automation.schedule.cronExpression.split(" ")[1]).toBe("2");
      expect(automation.schedule.timezone).toBe("Asia/Shanghai");
    }
    await withMockNowForTest(
      new Date(automation.nextRunAt).getTime(),
      async () => {
        await owned.run(() => {
          return accept(
            app(cronExecuteWorkflowAutomationsContract).execute({
              headers: cronHeaders,
            }),
            [200],
          );
        });
        await owned.run(flushWaitUntilForTest);
      },
    );
    const current = await owned.run(() => {
      return accept(
        app(workflowAutomationsContract).get({
          headers,
          params: { id: automation.id },
        }),
        [200],
      );
    });
    const chatThreadId = current.body.chatThreadId;
    if (!chatThreadId) {
      throw new Error("Expected the Official workflow execution thread");
    }
    const events = await owned.run(() => {
      return createChatFilesBddApi(context).listThreadEventRows(
        actor,
        chatThreadId,
      );
    });
    const launched = events.find((event) => {
      return event.eventType === "input.prompt" && event.runId;
    });
    if (!launched?.runId) {
      throw new Error("Expected the Official Workflow Run");
    }
    const runId = launched.runId;
    const { claim, sandboxHeaders } = await owned.claimChatRun(
      owned.runnerGroup,
      runId,
    );
    if (curatesSuggestions) {
      expect(claim.appendSystemPrompt).toContain(
        "# Suggestions feedback context",
      );
      expect(claim.appendSystemPrompt).toContain(
        '"complete":true,"feedback":[]',
      );
    } else {
      expect(claim.appendSystemPrompt).not.toContain(
        "# Suggestions feedback context",
      );
    }
    const bundle = claim.contentBundles.skills.find((skill) => {
      return skill.mountPath.endsWith(`/${definitionName}`);
    });
    if (!bundle) {
      throw new Error("Expected an Official Workflow bundle in the claim");
    }
    const files = readClaimedContentBundle(s3.objects, bundle);
    expect(files.get("SKILL.md")?.toString()).toContain(heading);
    expectScopeGuidance(files.get("SKILL.md")?.toString(), learning);
    expectPublishingReference(
      files,
      detail.body.fileContents,
      !curatesSuggestions,
    );
    await owned.run(() => {
      return fixture.failChatRun(
        runId,
        sandboxHeaders,
        "Official Workflow inspected",
      );
    });
    await owned.run(flushWaitUntilForTest);
    async function finishConcurrentSuggestions() {
      const suggestions = workflows.body.find((item) => {
        return item.official?.definitionName === "agent-suggestions";
      });
      if (!suggestions) {
        throw new Error("Expected the Suggestions installation");
      }
      const schedules = await owned.run(() => {
        return accept(
          app(workflowAutomationsContract).list({
            headers,
            params: { workflowId: suggestions.id },
          }),
          [200],
        );
      });
      const threadId = schedules.body[0]?.chatThreadId;
      if (threadId) {
        const events = await owned.run(() => {
          return createChatFilesBddApi(context).listThreadEventRows(
            actor,
            threadId,
          );
        });
        const runId = events.find((event) => {
          return event.eventType === "input.prompt" && event.runId;
        })?.runId;
        if (!runId) {
          throw new Error("Expected the concurrent Suggestions Run");
        }
        const { sandboxHeaders } = await owned.claimChatRun(
          owned.runnerGroup,
          runId,
        );
        await owned.run(() => {
          return fixture.failChatRun(
            runId,
            sandboxHeaders,
            "Concurrent Suggestions inspected",
          );
        });
        await owned.run(flushWaitUntilForTest);
      }
    }
    if (curatesMorningBrief) {
      await finishConcurrentSuggestions();
    }
  },
);
