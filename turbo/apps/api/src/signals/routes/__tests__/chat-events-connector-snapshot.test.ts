import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import {
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { settleIncludingAbort } from "../../utils";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { manualHttpCustomConnectorCreateBody } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatConnectorAccessApi } from "./helpers/chat-connector-access";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";

const ONE_HOUR_MS = 60 * 60 * 1000;

describe("chat-events-connector-snapshot", () => {
  const context = testContext();

  async function setupCustomSlackPermissionRun() {
    const startTime = now();
    let clockTime = startTime;
    const fixture = createChatEventsFixture(context);
    const runsApi = createRunsApi(context);
    const connectorAccess = createChatConnectorAccessApi(context);
    const actor = fixture.bdd.user();
    let accepted = captureConnectorExternalState(context);
    let previous: (() => void) | undefined;
    onTestFinished(() => {
      previous?.();
    });
    const owner = publicRunOwner(context, actor, {
      clockTime: () => {
        return clockTime;
      },
      continueAcceptedOperations: true,
      restoreEnvironment: () => {
        previous ??= captureConnectorExternalState(context);
        accepted();
      },
    });
    function run<T>(operation: () => Promise<T>) {
      return owner.run(() => {
        const pending = settleIncludingAbort(operation);
        accepted = captureConnectorExternalState(context);
        return pending.then((result) => {
          if (!result.ok) {
            throw result.error;
          }
          return result.value;
        });
      });
    }

    fixture.chatCallbacks.acceptChatObjectStorage();
    fixture.api.acceptStorageDownloads();
    fixture.api.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    fixture.chatCallbacks.disableVapid();
    mockClaudeCodeTokenEndpoint();

    const runnerGroupPromise = fixture.api.configureRunnerGroup();
    const [connector] = await Promise.all([
      run(() => {
        return fixture.connectors.createCustomConnector(
          actor,
          manualHttpCustomConnectorCreateBody({
            displayName: "Custom Slack Refresh",
            prefixTemplates: ["https://slack.example.test/api"],
            permissionBundleRef: "builtin:slack@1",
          }),
        );
      }),
      runnerGroupPromise,
      run(() => {
        return fixture.api.grantProEntitlement(actor);
      }),
    ]);

    await Promise.all([
      run(() => {
        return fixture.api.createPersonalModelProvider(actor, {
          type: "claude-code-oauth-token",
          secret: "bdd-personal-claude-token",
        });
      }),
      run(() => {
        return fixture.connectors.setCustomConnectorSecret(
          actor,
          connector.id,
          "custom-slack-secret",
        );
      }),
    ]);

    const permissions = await run(() => {
      return connectorAccess.applyPermissions(actor, {
        target: { kind: "custom", customConnectorId: connector.id },
        mode: "patch",
        grants: [
          { permission: "chat:write", action: "allow", expiresIn: "1h" },
        ],
      });
    });
    const grantExpiry = permissions.grants.find((grant) => {
      return grant.permission === "chat:write";
    })?.expiresAt;
    if (!grantExpiry) {
      throw new Error("Expected chat:write allow grant to have an expiry");
    }

    const chatRun = await run(() => {
      return fixture.sendChatRun(actor, {
        model: "claude-fable-5-1",
        prompt: "Post an update through the custom Slack connector",
      });
    });
    const execution = await run(async () => {
      const dispatched = await fixture.api.executionInput(chatRun.runId);
      owner.rememberExecution(chatRun.runId, dispatched.sandboxToken);
      return dispatched;
    });
    const customTarget = execution.connectorRuntimeTargets.find((target) => {
      return (
        target.kind === "custom" && target.customConnectorId === connector.id
      );
    });
    if (!customTarget) {
      throw new Error("Expected custom connector target on execution context");
    }
    const customFirewall = execution.firewalls?.find((entry) => {
      return (
        entry.kind === "inline" && entry.customConnectorId === connector.id
      );
    });
    if (!customFirewall || customFirewall.kind !== "inline") {
      throw new Error("Expected inline custom firewall on execution context");
    }
    expect(
      execution.networkPolicies?.[customFirewall.firewall.name]?.allow,
    ).toContain("chat:write");

    return {
      connectorId: connector.id,
      customTarget,
      grantExpiry,
      run,
      runId: chatRun.runId,
      runsApi,
      setClockTime(nextTime: number): void {
        clockTime = nextTime;
      },
      startTime,
    };
  }

  it(
    "chat-events-connector-snapshot-001 retains custom permission refresh while the Run is active before expiry",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const state = await setupCustomSlackPermissionRun();

      state.setClockTime(state.startTime + ONE_HOUR_MS / 2);
      const results = await state.run(() => {
        return state.runsApi.syncConnectorRuntime(state.runId, {
          targets: [state.customTarget],
        });
      });

      expect(results).toHaveLength(1);
      const synced = results[0];
      expect(synced).toMatchObject({
        target: { kind: "custom", customConnectorId: state.connectorId },
        state: "available",
        nextSyncAt: state.grantExpiry,
      });
      if (!synced || synced.state !== "available") {
        throw new Error("Expected synced custom connector to be available");
      }
      expect(synced.networkPolicy.allow).toContain("chat:write");
      expect(synced.networkPolicy.deny).not.toContain("chat:write");
    },
  );

  it(
    "chat-events-connector-snapshot-002 revokes expired custom permission on active Run sync without a next sync time",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const state = await setupCustomSlackPermissionRun();

      state.setClockTime(state.startTime + ONE_HOUR_MS);
      const results = await state.run(() => {
        return state.runsApi.syncConnectorRuntime(state.runId, {
          targets: [state.customTarget],
        });
      });

      expect(results).toHaveLength(1);
      const synced = results[0];
      expect(synced).toMatchObject({
        target: { kind: "custom", customConnectorId: state.connectorId },
        state: "available",
      });
      if (!synced || synced.state !== "available") {
        throw new Error("Expected synced custom connector to be available");
      }
      expect(synced.networkPolicy.allow).not.toContain("chat:write");
      expect(synced.networkPolicy.deny).toContain("chat:write");
      expect(synced.nextSyncAt).toBeUndefined();
    },
  );
});
