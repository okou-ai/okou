import { randomUUID } from "node:crypto";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  runPhaseTimingContract,
  type RunPhaseMark,
} from "@okouai/api-contracts/contracts/run-phase-timing";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isStaffOrg } from "@okouai/core/staff-org";
import { describe, expect, it, onTestFinished } from "vitest";

import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { now, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { featureSwitchesRoutes } from "../feature-switches";
import { runPhaseTimingRoutes } from "../run-phase-timing";
import { createBddApi, type ApiTestUserOptions } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createWebhookCallbackApi,
  deliverOrganizationCreated,
} from "./helpers/api-bdd-webhooks";
import { okouTokenFromExecution } from "./helpers/chat-events-fixture";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { createRouteMocks } from "./helpers/route-test";

// Dedicated unshared identities matching the FNV-1a rollout hashes so tests
// exercise real identity classes without sharing rows across parallel files.
const STAFF_ORG_ID = "org_run_phase_timing_staff_0ajLKH";
const ALLOWLISTED_OWNER_001_USER_ID = "user_run_phase_timing_001_04nuUH";
const ALLOWLISTED_OWNER_007_USER_ID = "user_run_phase_timing_007_1X9eBm";
const ALLOWLISTED_OWNER_008_USER_ID = "user_run_phase_timing_008_0uo0YH";

const TIMING_OPTIONAL_ENVS = Object.freeze(["OPENROUTER_API_KEY"] as const);

const EXPECTED_ACCEPTED_MARK = Object.freeze({
  status: 202,
  body: Object.freeze({ schemaVersion: 2, status: "accepted" }),
  cacheControl: "no-store",
});

const EXPECTED_UNAVAILABLE_MARK = Object.freeze({
  status: 404,
  cacheControl: "no-store",
});

function expectThreePointGuidance(systemPrompt: string | null): void {
  expect(systemPrompt).toContain(
    "the only AI phase marks are research-start and generation-start",
  );
  expect(systemPrompt).toContain("`okou run mark research-start`");
  expect(systemPrompt).toContain(
    "`okou run mark generation-start --kind <kind>`",
  );
  expect(systemPrompt).toContain(
    "The authenticated successful Agent completion callback automatically supplies the third mark, `completion-callback`",
  );
}

describe("current Run phase timing", () => {
  const context = testContext();

  function phaseTimingClient() {
    return setupAppWithRoutes({
      context,
      routes: runPhaseTimingRoutes,
    })(runPhaseTimingContract);
  }

  async function postPhaseMark<TStatus extends 202 | 400 | 401 | 403 | 404>(
    okouToken: string,
    body: RunPhaseMark,
    statuses: readonly TStatus[],
  ) {
    return await accept(
      phaseTimingClient().mark({
        headers: { authorization: `Bearer ${okouToken}` },
        body,
      }),
      statuses,
    );
  }

  async function postAcceptedMark(okouToken: string, body: RunPhaseMark) {
    const response = await postPhaseMark(okouToken, body, [202]);
    return {
      status: response.status,
      body: response.body,
      cacheControl: response.headers.get("cache-control"),
    };
  }

  async function postUnavailableMark(okouToken: string, body: RunPhaseMark) {
    const response = await postPhaseMark(okouToken, body, [404]);
    return {
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
    };
  }

  async function readEffectiveTimingSwitch(actor: {
    readonly userId: string;
    readonly orgId: string;
    readonly orgRole?: "org:admin" | "org:member";
  }): Promise<boolean> {
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
    const response = await accept(
      setupAppWithRoutes({
        context,
        routes: featureSwitchesRoutes,
      })(featureSwitchesContract).get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    return Boolean(
      response.body.effectiveSwitches[
        FeatureSwitchKey.ArtifactThreePointTiming
      ],
    );
  }

  async function startTimingRun(
    options: {
      readonly actor?: ApiTestUserOptions;
      readonly model?: "claude-fable-5-1" | null;
      readonly initialTimingSwitch?: boolean;
    } = {},
  ) {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const chat = createChatFilesBddApi(context);
    const chatCallbacks = createChatCallbacksApi(context);
    const webhooks = createWebhookCallbackApi(context);

    const actor = bdd.user(options.actor);
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected a workspace actor");
    }
    const useFableModel = options.model === "claude-fable-5-1";
    const clockTime = now();
    let ownsFeatures = options.initialTimingSwitch !== undefined;
    let launchedRun:
      { readonly runId: string; readonly sandboxToken: string } | undefined;

    const restoreBefore = captureConnectorExternalState(
      context,
      TIMING_OPTIONAL_ENVS,
    );
    let restoreAccepted = restoreBefore;

    onTestFinished(async () => {
      restoreAccepted();
      context.mocks.ably.publish.mockResolvedValue(undefined);
      const result = await settleIncludingAbort(() => {
        return withMockNowForTest(clockTime, async () => {
          await flushWaitUntilForTest();
          await Promise.all([
            launchedRun
              ? (async () => {
                  const targetRun = launchedRun;
                  await runs.requestCancelRun(actor, targetRun.runId, [200]);
                  await webhooks.requestAgentComplete(
                    {
                      runId: targetRun.runId,
                      exitCode: 1,
                      error: "Run cancelled",
                    },
                    { authorization: `Bearer ${targetRun.sandboxToken}` },
                    [200],
                  );
                })()
              : Promise.resolve(),
            ownsFeatures
              ? deleteFeatureSwitchesForUser(context, { ...actor, orgId })
              : Promise.resolve(),
          ]);
          await flushWaitUntilForTest();
        });
      });
      restoreBefore();
      if (!result.ok) {
        throw result.error;
      }
    });

    chatCallbacks.acceptChatObjectStorage();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    chatCallbacks.disableVapid();
    mockOptionalEnv(
      "OPENROUTER_API_KEY",
      useFableModel ? undefined : "bdd-issued-credential-key",
    );
    if (useFableModel) {
      mockClaudeCodeTokenEndpoint();
    }
    restoreAccepted = captureConnectorExternalState(
      context,
      TIMING_OPTIONAL_ENVS,
    );

    const execution = await withMockNowForTest(clockTime, async () => {
      const [runnerGroup] = await Promise.all([
        runs.configureRunnerGroup(),
        deliverOrganizationCreated(context, actor),
        ...(useFableModel
          ? [
              runs.createPersonalModelProvider(actor, {
                type: "claude-code-oauth-token",
                secret: "bdd-personal-claude-token",
              }),
            ]
          : []),
        ...(options.initialTimingSwitch !== undefined
          ? [
              updateFeatureSwitchesForUser(
                context,
                { ...actor, orgId },
                {
                  [FeatureSwitchKey.ArtifactThreePointTiming]:
                    options.initialTimingSwitch,
                },
              ),
            ]
          : []),
      ]);
      await chat.requestSendEvent(
        actor,
        {
          prompt: "Prepare a short report artifact.",
          clientEventId: randomUUID(),
          model: useFableModel ? "claude-fable-5-1" : null,
        },
        [201],
        {},
      );
      const dispatched = await runs.nextReceivedExecution(runnerGroup);
      launchedRun = {
        runId: dispatched.runId,
        sandboxToken: dispatched.sandboxToken,
      };
      return dispatched;
    });

    return {
      bdd,
      orgId,
      execution,
      okouToken: okouTokenFromExecution(execution),
      async setTimingSwitch(enabled: boolean): Promise<void> {
        ownsFeatures = true;
        await updateFeatureSwitchesForUser(
          context,
          { ...actor, orgId },
          { [FeatureSwitchKey.ArtifactThreePointTiming]: enabled },
        );
      },
    };
  }

  it(
    "run-phase-timing-003 gives an ordinary user with default settings three-point guidance and accepts phase observations",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { orgId, execution, okouToken } = await startTimingRun();

      expect(isStaffOrg(orgId)).toBeFalsy();
      expectThreePointGuidance(execution.appendSystemPrompt);

      await expect(
        postAcceptedMark(okouToken, { phase: "research-start" }),
      ).resolves.toStrictEqual(EXPECTED_ACCEPTED_MARK);
      await expect(
        postAcceptedMark(okouToken, {
          phase: "generation-start",
          kind: "report",
          skipResearch: false,
        }),
      ).resolves.toStrictEqual(EXPECTED_ACCEPTED_MARK);
    },
  );

  it(
    "run-phase-timing-004 gives an ordinary user with stored opt-in settings three-point guidance and accepts phase observations",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { orgId, execution, okouToken } = await startTimingRun({
        initialTimingSwitch: true,
      });

      expect(isStaffOrg(orgId)).toBeFalsy();
      expectThreePointGuidance(execution.appendSystemPrompt);

      await expect(
        postAcceptedMark(okouToken, { phase: "research-start" }),
      ).resolves.toStrictEqual(EXPECTED_ACCEPTED_MARK);
      await expect(
        postAcceptedMark(okouToken, {
          phase: "generation-start",
          kind: "report",
          skipResearch: false,
        }),
      ).resolves.toStrictEqual(EXPECTED_ACCEPTED_MARK);
    },
  );

  it(
    "pf-116 honors a personal opt-out in Run guidance and phase observations",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { bdd, orgId, execution, okouToken } = await startTimingRun({
        initialTimingSwitch: false,
      });

      expect(execution.appendSystemPrompt ?? "").not.toContain("okou run mark");

      await expect(
        postUnavailableMark(okouToken, { phase: "research-start" }),
      ).resolves.toStrictEqual(EXPECTED_UNAVAILABLE_MARK);
      await expect(
        postUnavailableMark(okouToken, {
          phase: "generation-start",
          kind: "report",
          skipResearch: false,
        }),
      ).resolves.toStrictEqual(EXPECTED_UNAVAILABLE_MARK);

      const colleague = bdd.user({ orgId, orgRole: "org:member" });
      await expect(
        readEffectiveTimingSwitch({
          userId: colleague.userId,
          orgId,
          orgRole: "org:member",
        }),
      ).resolves.toBeTruthy();
    },
  );

  it(
    "run-phase-timing-007 accepts the originally issued Run token after the owner enables timing live",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { execution, okouToken, setTimingSwitch } = await startTimingRun({
        actor: { userId: ALLOWLISTED_OWNER_007_USER_ID },
        initialTimingSwitch: false,
      });

      expect(execution.appendSystemPrompt ?? "").not.toContain("okou run mark");
      await expect(
        postUnavailableMark(okouToken, { phase: "research-start" }),
      ).resolves.toStrictEqual(EXPECTED_UNAVAILABLE_MARK);

      await setTimingSwitch(true);

      await expect(
        postAcceptedMark(okouToken, { phase: "research-start" }),
      ).resolves.toStrictEqual(EXPECTED_ACCEPTED_MARK);
      await expect(
        postAcceptedMark(okouToken, {
          phase: "generation-start",
          kind: "report",
          skipResearch: false,
        }),
      ).resolves.toStrictEqual(EXPECTED_ACCEPTED_MARK);
    },
  );

  it(
    "run-phase-timing-008 honors a live kill switch for an already issued Run token",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { okouToken, setTimingSwitch } = await startTimingRun({
        actor: { userId: ALLOWLISTED_OWNER_008_USER_ID },
      });

      await expect(
        postAcceptedMark(okouToken, { phase: "research-start" }),
      ).resolves.toStrictEqual(EXPECTED_ACCEPTED_MARK);

      await setTimingSwitch(false);

      await expect(
        postUnavailableMark(okouToken, { phase: "research-start" }),
      ).resolves.toStrictEqual(EXPECTED_UNAVAILABLE_MARK);
    },
  );

  it(
    "run-phase-timing-001 gives the allowlisted owner three-point guidance and accepts legal raw observations",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { execution, okouToken } = await startTimingRun({
        actor: { userId: ALLOWLISTED_OWNER_001_USER_ID },
        model: "claude-fable-5-1",
      });

      expectThreePointGuidance(execution.appendSystemPrompt);

      await expect(
        postAcceptedMark(okouToken, {
          phase: "generation-start",
          kind: "report",
          skipResearch: false,
        }),
      ).resolves.toStrictEqual(EXPECTED_ACCEPTED_MARK);
      await expect(
        postAcceptedMark(okouToken, { phase: "research-start" }),
      ).resolves.toStrictEqual(EXPECTED_ACCEPTED_MARK);
      await expect(
        postAcceptedMark(okouToken, {
          phase: "generation-start",
          kind: "image",
          skipResearch: true,
        }),
      ).resolves.toStrictEqual(EXPECTED_ACCEPTED_MARK);
      await expect(
        postAcceptedMark(okouToken, { phase: "research-start" }),
      ).resolves.toStrictEqual(EXPECTED_ACCEPTED_MARK);
    },
  );

  it(
    "run-phase-timing-002 gives the staff workspace member three-point guidance and accepts legal raw observations",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      expect(isStaffOrg(STAFF_ORG_ID)).toBeTruthy();
      const { execution, okouToken } = await startTimingRun({
        actor: { orgId: STAFF_ORG_ID },
        model: "claude-fable-5-1",
      });

      expectThreePointGuidance(execution.appendSystemPrompt);

      await expect(
        postAcceptedMark(okouToken, {
          phase: "generation-start",
          kind: "report",
          skipResearch: false,
        }),
      ).resolves.toStrictEqual(EXPECTED_ACCEPTED_MARK);
      await expect(
        postAcceptedMark(okouToken, { phase: "research-start" }),
      ).resolves.toStrictEqual(EXPECTED_ACCEPTED_MARK);
      await expect(
        postAcceptedMark(okouToken, {
          phase: "generation-start",
          kind: "image",
          skipResearch: true,
        }),
      ).resolves.toStrictEqual(EXPECTED_ACCEPTED_MARK);
      await expect(
        postAcceptedMark(okouToken, { phase: "research-start" }),
      ).resolves.toStrictEqual(EXPECTED_ACCEPTED_MARK);
    },
  );
});
