import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";
import {
  updateFeatureSwitchesForUser,
  deleteFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import {
  DIRECT_APP_STATE_CAPABILITY,
  runnerAppStateContract,
} from "@okouai/api-contracts/contracts/computer-use";
import { env, mockEnv } from "../../../lib/env";
import { setupApp } from "../../../__tests__/test-helpers";
import { testContext } from "../../../__tests__/test-context";
import { runnerAppStateRoutes } from "../runner-app-state";

const context = testContext();
test("requires official Runner authentication and a current direct command", async () => {
  mockEnv("OFFICIAL_RUNNER_SECRET", "c".repeat(64));
  const client = setupApp({ context, routes: runnerAppStateRoutes })(
    runnerAppStateContract,
  );
  const request = {
    params: { runId: randomUUID(), commandId: randomUUID() },
    body: { runnerId: randomUUID(), heartbeatGeneration: 1 },
  };
  const unauthenticated = await client.check({
    ...request,
    headers: { authorization: "Bearer unused" },
  });
  expect(unauthenticated.status).toBe(401);
  const noGrant = await client.check({
    ...request,
    headers: { authorization: `Bearer vm0_official_${"c".repeat(64)}` },
  });
  expect(noGrant.status).toBe(404);
});

test("only the assigned Runner and claimed Mac can deliver an opted-in capture", async () => {
  const owner = createPublicComputerUseScenario(context);
  const api = owner.computerUse;
  const actor = owner.user({ orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" });
  const capabilities = ["app.state", DIRECT_APP_STATE_CAPABILITY];
  const mac = await api.startComputerUseHost(actor, {
    supportedCapabilities: capabilities,
  });
  const run = await owner.launchRun(actor, mac.hostId);
  const { runnerId, heartbeatGeneration } = createRunsApi(
    context,
  ).dispatchedRun(run.runId);
  const receiver = { runnerId, heartbeatGeneration };
  const auth = { bearer: run.token };
  const request = {
    kind: "app.state",
    app: "com.apple.TextEdit",
    appStateRunner: receiver,
  } as const;

  const legacy = await api.createComputerUseReadCommand(auth, request);
  expect(legacy.directAppState).toBeUndefined();
  await expect(
    api.claimNextComputerUseCommand(mac.connection, capabilities),
  ).resolves.toMatchObject({
    status: "command",
    command: { id: legacy.commandId },
  });
  await api.completeComputerUseCommandWith(mac.connection, legacy.commandId, {
    status: "failed",
    error: { code: "app_not_found", message: "The test window was closed" },
  });
  const toggle = (value: boolean) => {
    return owner.run(() => {
      return updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.ComputerUseAppStateDirectTransfer]: value,
      });
    });
  };
  owner.beforeWorkspaceCleanup(() => {
    return deleteFeatureSwitchesForUser(context, actor);
  });
  await toggle(true);
  const direct = await api.createComputerUseReadCommand(auth, request);
  expect(direct.directAppState).toBeTruthy();
  const check = (identity = receiver) => {
    return owner.run(() => {
      return setupApp({ context, routes: runnerAppStateRoutes })(
        runnerAppStateContract,
      ).check({
        headers: {
          authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
        },
        params: { runId: run.runId, commandId: direct.commandId },
        body: identity,
      });
    });
  };
  expect((await check()).body).toStrictEqual({
    hostId: mac.hostId,
    claimed: false,
  });
  expect(
    (await check({ ...receiver, heartbeatGeneration: heartbeatGeneration + 1 }))
      .status,
  ).toBe(404);
  await toggle(false);
  const claim = await api.claimNextComputerUseCommand(
    mac.connection,
    capabilities,
  );
  expect(claim).toMatchObject({
    status: "command",
    command: {
      id: direct.commandId,
      appStateUpload: {
        url: expect.stringContaining(
          `/runners/${runnerId}/sandbox/runs/${run.runId}/app-state/${direct.commandId}`,
        ),
        token: expect.any(String),
      },
    },
  });
  expect((await check()).body).toStrictEqual({
    hostId: mac.hostId,
    claimed: true,
  });
  const status = await api.requestReadComputerUseCommand(
    auth,
    direct.commandId,
    [200],
  );
  expect(status.body).not.toHaveProperty("appStateUpload");
  await api.stopComputerUseHost(mac.connection);
  expect((await check()).status).toBe(404);
});
