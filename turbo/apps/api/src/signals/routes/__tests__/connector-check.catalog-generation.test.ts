import { randomUUID } from "node:crypto";

import {
  CONNECTOR_CHECK_AWS_CONTEXT_HEADER,
  CONNECTOR_CHECK_AWS_CONTEXT_INSUFFICIENT,
  type ConnectorCheckRequest,
  type ConnectorCheckRequestBody,
  connectorCheckContract,
} from "@okouai/api-contracts/contracts/connector-check";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settle } from "../../utils";
import { createAuthDeviceApiActions } from "./helpers/api-bdd-auth-device";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import {
  awsVerificationCode,
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
  mockAwsExternalCodeProvider,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  seedConnectorStorageRow,
  setConnectorDefaultState,
  setConnectorCredentialStorageState,
  setConnectorVariableOwner,
} from "./helpers/connector-credential-storage-state";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/org-membership";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import {
  API_TEST_CONNECTOR_CATALOG,
  catalogWithManualConnector,
  createPublicConnectorCatalog,
} from "./helpers/public-connector-catalog";
import { connectorCheckRoutes } from "../connector-check";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";

const TEST_APP_ROUTES = Object.freeze([
  ...connectorCheckRoutes,
  ...testCronCleanupSandboxesStateRoutes,
]);

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);

function client() {
  return setupApp({ context, routes: TEST_APP_ROUTES })(connectorCheckContract);
}

async function checkWithSession(
  actor: ApiTestUser,
  body: ConnectorCheckRequest,
) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return await accept(
    client().check({
      headers: { authorization: "Bearer clerk-session" },
      body,
    }),
    [200],
  );
}

beforeEach(() => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  context.mocks.axiom.query.mockResolvedValue([]);
});

describe("POST /api/connectors/diagnostics/check", () => {
  it("ignores stale stored connectors that are absent from the catalog", async () => {
    const actor = bdd.user();
    const catalog = createPublicConnectorCatalog(context);
    const available = catalogWithManualConnector({
      connectorSlug: "removed-connector",
      authMethodId: "api",
    });
    await catalog.publish(available);
    await connectorsApi.connectManualGrant(actor, "removed-connector", "api", {
      credential: "removed-connector-secret",
    });
    catalog.onCleanup(async () => {
      await catalog.publish(available);
      await connectorsApi.deleteDefaultBuiltinConnectorAccount(
        actor,
        "removed-connector",
      );
    });
    await catalog.publish(API_TEST_CONNECTOR_CATALOG);

    const response = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: "https://api.github.com/repos/okou-ai/okou",
    });

    expect(response.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorSlug: "github" },
    });
    await catalog.cleanup();
  });
});
