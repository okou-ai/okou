import { randomUUID } from "node:crypto";

import {
  connectorAccountsContract,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  CONNECTOR_CHECK_AWS_CONTEXT_HEADER,
  connectorCheckContract,
  type ConnectorCheckRequestBody,
} from "@okouai/api-contracts/contracts/connector-check";
import { builtinConnectorManualGrantContract } from "@okouai/api-contracts/contracts/connectors";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorCheckRoutes } from "../connector-check";
import { builtinConnectorsRoutes } from "../connectors";
import { createBddApi } from "./helpers/api-bdd";
import { createAuthDeviceApiActions } from "./helpers/api-bdd-auth-device";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  createChatEventsFixture,
  okouTokenFromExecution,
} from "./helpers/chat-events-fixture";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

function newActor(orgId = `org_${randomUUID()}`): Actor {
  return { userId: `user_${randomUUID()}`, orgId };
}

function as(actor: Actor) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:member",
  );
  return { authorization: "Bearer clerk-session" };
}

async function check(actor: Actor, body: ConnectorCheckRequestBody) {
  const client = setupApp({ context, routes: connectorCheckRoutes })(
    connectorCheckContract,
  );
  return await accept(client.check({ headers: as(actor), body }), [200]);
}

async function checkBody(actor: Actor, body: ConnectorCheckRequestBody) {
  return (await check(actor, body)).body;
}

const REAP: ConnectorAccountTarget = Object.freeze({
  kind: "builtin",
  connectorSlug: "reap",
});

function accounts() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

async function connectReap(
  actor: Actor,
  values: { readonly apiKey: string; readonly apiBaseUrl: string },
  reconnect?: string,
) {
  const client = setupApp({ context, routes: builtinConnectorsRoutes })(
    builtinConnectorManualGrantContract,
  );
  const response = await accept(
    client.connect({
      params: { connectorSlug: "reap" },
      headers: as(actor),
      body: {
        authMethod: "api-token",
        values,
        account:
          reconnect === undefined
            ? { intent: "add" }
            : { intent: "reconnect", connectionId: reconnect },
      },
    }),
    [200],
  );
  return response.body.connectionId;
}

async function setDefaultReap(actor: Actor, connectionId: string) {
  await accept(
    accounts().setDefault({
      headers: as(actor),
      params: { connectionId },
      body: { target: REAP },
    }),
    [200],
  );
}

async function deleteReap(actor: Actor, connectionId: string) {
  await accept(
    accounts().delete({
      headers: as(actor),
      params: { connectionId },
      body: { target: REAP },
    }),
    [200],
  );
}

async function listReap(actor: Actor) {
  const response = await accept(
    accounts().connections({
      headers: as(actor),
      query: { kind: "builtin", connectorSlug: "reap", limit: 50 },
    }),
    [200],
  );
  return response.body.connections;
}

function reapBase() {
  return `https://reap-${randomUUID()}.example.org`;
}

function usersCheck(base: string): ConnectorCheckRequestBody {
  return {
    mode: "url",
    method: "GET",
    url: `${base}/users`,
    connectorSlug: "reap",
  };
}

const REAP_IDENTITY = Object.freeze({
  target: REAP,
  label: "Reap",
  visibility: "available",
  credentialResolution: "network-boundary",
});

function resolvedReap(base: string) {
  return {
    outcome: "resolved",
    mode: "url",
    connector: REAP_IDENTITY,
    environmentNames: ["REAP_API_KEY"],
    run: { status: "not-scoped" },
    method: "GET",
    base,
    relativePath: "/users",
    permission: {
      kind: "matched",
      permissions: [
        {
          name: "read",
          policy: { outcome: "unavailable", basis: "not-run-scoped" },
        },
      ],
    },
  };
}

const UNRESOLVED_REAP = Object.freeze({
  outcome: "unresolved-dynamic-base",
  connector: REAP_IDENTITY,
});

describe("POST /api/connectors/diagnostics/check", () => {
  it("connector-check-005 reports AWS STS selectors outside a Run", async () => {
    const member = newActor();
    const url = "https://sts.amazonaws.com/";

    const missing = await check(member, { mode: "url", method: "POST", url });
    expect(missing.body).toMatchObject({
      outcome: "resolved",
      connector: { target: { kind: "builtin", connectorSlug: "aws" } },
      permission: {
        kind: "unknown-endpoint",
        policy: { outcome: "unavailable" },
      },
    });
    expect(missing.headers.get(CONNECTOR_CHECK_AWS_CONTEXT_HEADER)).toBe(
      "insufficient",
    );

    const explicit = await checkBody(member, {
      mode: "url",
      method: "POST",
      url,
      aws: { sigv4Service: "sts", action: "GetCallerIdentity" },
    });
    expect(explicit).toMatchObject({
      outcome: "resolved",
      environmentNames: [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
      ],
      permission: {
        kind: "matched",
        permissions: [
          {
            name: "sts:get-caller-identity",
            policy: { outcome: "unavailable" },
          },
        ],
      },
    });

    const unknown = await check(member, {
      mode: "url",
      method: "POST",
      url,
      aws: { sigv4Service: "sts", action: "AssumeRoleWithMagic" },
    });
    expect(unknown.body).toMatchObject({
      outcome: "resolved",
      permission: {
        kind: "unknown-endpoint",
        policy: { outcome: "unavailable" },
      },
    });
    expect(unknown.headers.get(CONNECTOR_CHECK_AWS_CONTEXT_HEADER)).toBeNull();

    const incompatible = await checkBody(member, {
      mode: "url",
      method: "POST",
      url,
      environmentName: "AWS_SESSION_TOKEN",
      aws: { sigv4Service: "sts", action: "GetSessionToken" },
    });
    expect(incompatible).toMatchObject({
      outcome: "environment-not-used",
      environmentNames: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    });
  });

  it("connector-check-009 accepts a device-flow PAT and resolves hidden catalog metadata without private refs", async () => {
    const userId = `user_${randomUUID()}`;
    const owner = {
      userId,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin" as const,
      email: `${userId}@example.test`,
    };
    const device = createAuthDeviceApiActions(context);
    const started = await device.startCliDevice();
    await device.requestCliApproval(
      owner,
      { device_code: started.device_code },
      [200],
    );
    const issued = await device.requestCliToken(started.device_code, [200]);
    const token = "access_token" in issued.body ? issued.body.access_token : "";
    const client = setupApp({ context, routes: connectorCheckRoutes })(
      connectorCheckContract,
    );
    const headers = { authorization: `Bearer ${token}` };

    const slack = await accept(
      client.check({
        headers,
        body: {
          mode: "url",
          method: "POST",
          url: "https://slack.com/api/chat.postMessage?channel=C-private#fragment",
        },
      }),
      [200],
    );
    expect(slack.body).toStrictEqual({
      outcome: "resolved",
      mode: "url",
      connector: {
        target: { kind: "builtin", connectorSlug: "slack" },
        label: "Slack",
        visibility: "available",
        credentialResolution: "network-boundary",
      },
      environmentNames: ["SLACK_TOKEN"],
      run: { status: "not-scoped" },
      method: "POST",
      base: "https://slack.com/api",
      relativePath: "/chat.postMessage",
      permission: {
        kind: "matched",
        permissions: [
          {
            name: "chat:write",
            policy: { outcome: "unavailable", basis: "not-run-scoped" },
          },
        ],
      },
    });
    expect(JSON.stringify(slack.body)).not.toMatch(/C-private|fragment/);

    const hidden = await accept(
      client.check({
        headers,
        body: {
          mode: "url",
          method: "GET",
          url: "https://pr1.vm6.ai/api/test/oauth-provider/echo",
          connectorSlug: "test-oauth",
        },
      }),
      [200],
    );
    expect(hidden.body).toMatchObject({
      outcome: "resolved",
      connector: {
        target: { kind: "builtin", connectorSlug: "test-oauth" },
        visibility: "unavailable",
      },
      relativePath: "/echo",
    });
    // Public env names stay; private storage names and variable templates
    // must not leak.
    expect(JSON.stringify(hidden.body)).not.toMatch(
      /TEST_OAUTH_API_TENANT_ID|TEST_OAUTH_ACCESS_TOKEN|vars\.|\$\{\{/,
    );
  });

  it("connector-check-010 resolves aliases, ambiguity and URL selectors deterministically", async () => {
    const member = newActor();
    const github = { kind: "builtin", connectorSlug: "github" };
    const parental = {
      kind: "builtin",
      connectorSlug: "nintendo-switch-parental-controls",
    };
    const userUrl = "https://api.github.com/user";
    const nintendoUrl = "https://api.accounts.nintendo.com/2.0.0/users/me";
    const get = (url: string) => {
      return { mode: "url", method: "GET", url } as const;
    };

    const [
      alias,
      unknownAlias,
      githubAlias,
      githubMismatch,
      githubNotOwned,
      deceptive,
      ambiguous,
      parentalTarget,
      parentalAlias,
      unknownSlug,
    ] = await Promise.all([
      checkBody(member, { mode: "environment", environmentName: "GH_TOKEN" }),
      checkBody(member, {
        mode: "environment",
        environmentName: "NOT_A_KNOWN_ALIAS",
      }),
      checkBody(member, { ...get(userUrl), environmentName: "GH_TOKEN" }),
      checkBody(member, { ...get(userUrl), connectorSlug: "slack" }),
      checkBody(member, {
        ...get(userUrl),
        environmentName: "AWS_ACCESS_KEY_ID",
      }),
      checkBody(member, get("https://api.github.com.evil.example.com/user")),
      checkBody(member, get(nintendoUrl)),
      checkBody(member, {
        ...get(nintendoUrl),
        connectorSlug: "nintendo-switch-parental-controls",
      }),
      checkBody(member, {
        ...get(nintendoUrl),
        connectorSlug: "nintendo-switch-parental-controls",
        environmentName: "NINTENDO_SWITCH_PARENTAL_CONTROLS_TOKEN",
      }),
      checkBody(member, {
        ...get(userUrl),
        connectorSlug: "not-a-real-connector",
      }),
    ]);

    expect(alias).toMatchObject({
      outcome: "resolved",
      connector: { target: github },
      environmentName: "GH_TOKEN",
      run: { status: "not-scoped" },
      permission: null,
    });
    expect(unknownAlias).toStrictEqual({ outcome: "unknown-environment" });
    expect(githubAlias).toMatchObject({
      outcome: "resolved",
      connector: { target: github },
      environmentNames: ["GH_TOKEN"],
    });
    expect(githubMismatch).toMatchObject({
      outcome: "connector-mismatch",
      connector: { target: github },
    });
    expect(githubNotOwned).toMatchObject({
      outcome: "environment-not-owned",
      connector: { target: github },
    });
    expect(deceptive).toStrictEqual({ outcome: "no-match", scope: "catalog" });
    expect(ambiguous).toMatchObject({ outcome: "ambiguous" });
    expect(
      "candidates" in ambiguous
        ? ambiguous.candidates.map((candidate) => {
            return candidate.target;
          })
        : [],
    ).toStrictEqual([
      { kind: "builtin", connectorSlug: "nintendo-store" },
      parental,
    ]);
    expect(parentalTarget).toMatchObject({
      outcome: "resolved",
      connector: { target: parental },
    });
    expect(parentalAlias).toMatchObject({
      outcome: "environment-not-used",
      connector: { target: parental },
      environmentNames: ["NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_TOKEN"],
    });
    expect(unknownSlug).toStrictEqual({ outcome: "unknown-connector" });
  });

  it("connector-check-011 resolves the dynamic base from the current owner account", async () => {
    const owner = newActor();
    const peer = newActor(owner.orgId);
    const otherWorkspace = {
      userId: owner.userId,
      orgId: `org_${randomUUID()}`,
    };
    const [baseA, baseB] = [reapBase(), reapBase()];
    const keys = [`reap-key-${randomUUID()}`, `reap-key-${randomUUID()}`];

    await expect(checkBody(owner, usersCheck(baseA))).resolves.toStrictEqual(
      UNRESOLVED_REAP,
    );
    const first = await connectReap(owner, {
      apiKey: keys[0] ?? "",
      apiBaseUrl: baseA,
    });
    const second = await connectReap(owner, {
      apiKey: keys[1] ?? "",
      apiBaseUrl: baseB,
    });

    const original = await checkBody(owner, usersCheck(baseA));
    expect(original).toStrictEqual(resolvedReap(baseA));
    await setDefaultReap(owner, second);
    await expect(checkBody(owner, usersCheck(baseB))).resolves.toStrictEqual(
      resolvedReap(baseB),
    );
    await setDefaultReap(owner, first);
    await expect(checkBody(owner, usersCheck(baseA))).resolves.toStrictEqual(
      original,
    );

    for (const other of [peer, otherWorkspace]) {
      await expect(checkBody(other, usersCheck(baseA))).resolves.toStrictEqual(
        UNRESOLVED_REAP,
      );
    }
    const serialized = JSON.stringify(original);
    for (const secret of [...keys, "REAP_API_BASE_URL", "apiBaseUrl"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("connector-check-012 (1/3) isolates initial unresolved and saved Reap snapshots across users", async () => {
    const alice = newActor();
    const bob = newActor(alice.orgId);
    const [baseA, baseB] = [reapBase(), reapBase()];
    const keyA = `reap-key-${randomUUID()}`;
    const keyB = `reap-key-${randomUUID()}`;

    await expect(checkBody(alice, usersCheck(baseA))).resolves.toStrictEqual(
      UNRESOLVED_REAP,
    );
    await expect(checkBody(bob, usersCheck(baseB))).resolves.toStrictEqual(
      UNRESOLVED_REAP,
    );

    const aliceAccount = await connectReap(alice, {
      apiKey: keyA,
      apiBaseUrl: baseA,
    });
    const bobAccount = await connectReap(bob, {
      apiKey: keyB,
      apiBaseUrl: baseB,
    });

    const [aliceOwn, aliceForeign] = await Promise.all([
      checkBody(alice, usersCheck(baseA)),
      checkBody(alice, usersCheck(baseB)),
    ]);
    expect(aliceOwn).toStrictEqual(resolvedReap(baseA));
    expect(aliceForeign).toStrictEqual({
      outcome: "no-match",
      scope: "catalog",
    });

    const [bobOwn, bobForeign] = await Promise.all([
      checkBody(bob, usersCheck(baseB)),
      checkBody(bob, usersCheck(baseA)),
    ]);
    expect(bobOwn).toStrictEqual(resolvedReap(baseB));
    expect(bobForeign).toStrictEqual({
      outcome: "no-match",
      scope: "catalog",
    });

    const serialized = JSON.stringify([aliceOwn, bobOwn]);
    for (const hidden of [
      keyA,
      keyB,
      aliceAccount,
      bobAccount,
      "REAP_API_BASE_URL",
      "apiBaseUrl",
      "storage",
    ]) {
      expect(serialized).not.toContain(hidden);
    }
  });

  it("connector-check-012 (2/3) updates only the reconnected owner base without changing the other user", async () => {
    const alice = newActor();
    const bob = newActor(alice.orgId);
    const [baseA, baseB, baseA2] = [reapBase(), reapBase(), reapBase()];
    const keyA = `reap-key-${randomUUID()}`;
    const keyB = `reap-key-${randomUUID()}`;
    const keyA2 = `reap-key-${randomUUID()}`;

    const aliceAccount = await connectReap(alice, {
      apiKey: keyA,
      apiBaseUrl: baseA,
    });
    const bobAccount = await connectReap(bob, {
      apiKey: keyB,
      apiBaseUrl: baseB,
    });
    const bobForeignBefore = await checkBody(bob, usersCheck(baseA));
    expect(bobForeignBefore).toStrictEqual({
      outcome: "no-match",
      scope: "catalog",
    });

    const reconnected = await connectReap(
      alice,
      { apiKey: keyA2, apiBaseUrl: baseA2 },
      aliceAccount,
    );
    expect(reconnected).toBe(aliceAccount);

    const [aliceAfter, aliceOldBase] = await Promise.all([
      checkBody(alice, usersCheck(baseA2)),
      checkBody(alice, usersCheck(baseA)),
    ]);
    expect(aliceAfter).toStrictEqual(resolvedReap(baseA2));
    expect(aliceOldBase).toStrictEqual({
      outcome: "no-match",
      scope: "catalog",
    });

    const [bobForeignAfter, bobOwnAfter] = await Promise.all([
      checkBody(bob, usersCheck(baseA)),
      checkBody(bob, usersCheck(baseB)),
    ]);
    expect(bobForeignAfter).toStrictEqual(bobForeignBefore);
    expect(bobOwnAfter).toStrictEqual(resolvedReap(baseB));

    const serialized = JSON.stringify([aliceAfter, bobOwnAfter]);
    for (const hidden of [
      keyA,
      keyB,
      keyA2,
      aliceAccount,
      bobAccount,
      "REAP_API_BASE_URL",
      "apiBaseUrl",
      "storage",
    ]) {
      expect(serialized).not.toContain(hidden);
    }
  });

  it("connector-check-012 (3/3) clears both owners' dynamic bases and account lists after deletion", async () => {
    const alice = newActor();
    const bob = newActor(alice.orgId);
    const [baseA, baseB] = [reapBase(), reapBase()];

    const aliceAccount = await connectReap(alice, {
      apiKey: `reap-key-${randomUUID()}`,
      apiBaseUrl: baseA,
    });
    const bobAccount = await connectReap(bob, {
      apiKey: `reap-key-${randomUUID()}`,
      apiBaseUrl: baseB,
    });

    await deleteReap(alice, aliceAccount);
    await deleteReap(bob, bobAccount);

    const [aliceFinal, aliceList] = await Promise.all([
      checkBody(alice, usersCheck(baseA)),
      listReap(alice),
    ]);
    const [bobFinal, bobList] = await Promise.all([
      checkBody(bob, usersCheck(baseB)),
      listReap(bob),
    ]);
    expect(aliceFinal).toStrictEqual(UNRESOLVED_REAP);
    expect(bobFinal).toStrictEqual(UNRESOLVED_REAP);
    expect(aliceList).toStrictEqual([]);
    expect(bobList).toStrictEqual([]);
  });

  it(
    "connector-check-026 reads a real registration and rejects diagnostics after normal Run cancellation",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const bdd = createBddApi(context);
      const actor = bdd.user();
      const owner = publicRunOwner(context, actor);
      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();

      await Promise.all([
        fixture.api.configureRunnerGroup(),
        owner.run(() => {
          return bdd.bootstrapLimitedFreeOnboarding(actor);
        }),
      ]);

      const launched = await owner.run(() => {
        return fixture.sendChatRun(actor, {
          prompt: "Inspect GH_TOKEN connector diagnostics",
          model: null,
        });
      });
      const execution = await owner.executionInput(launched.runId);
      const okouToken = okouTokenFromExecution(execution);
      const client = setupApp({ context, routes: connectorCheckRoutes })(
        connectorCheckContract,
      );
      const runHeaders = { authorization: `Bearer ${okouToken}` };

      const live = await accept(
        client.check({
          headers: runHeaders,
          body: { mode: "environment", environmentName: "GH_TOKEN" },
        }),
        [200],
      );
      expect(live.body).toMatchObject({
        outcome: "resolved",
        mode: "environment",
        connector: {
          target: { kind: "builtin", connectorSlug: "github" },
          visibility: "available",
          credentialResolution: "network-boundary",
        },
        run: { status: "not-configured" },
        permission: null,
      });

      await owner.run(() => {
        return fixture.api.requestCancelRun(actor, launched.runId, [200]);
      });
      await createWebhookCallbackApi(context).requestAgentComplete(
        { runId: launched.runId, exitCode: 1, error: "Cancelled by owner" },
        { authorization: `Bearer ${execution.sandboxToken}` },
        [200],
      );

      const afterCancel = await accept(
        client.check({
          headers: runHeaders,
          body: { mode: "environment", environmentName: "GH_TOKEN" },
        }),
        [404],
      );
      expect(afterCancel.body).toMatchObject({
        error: {
          code: "NOT_FOUND",
          message: "Agent run not found",
        },
      });
    },
  );
});
