import { randomUUID } from "node:crypto";

import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorCheckContract } from "@okouai/api-contracts/contracts/connector-check";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { builtinConnectorManualGrantContract } from "@okouai/api-contracts/contracts/connectors";
import {
  customConnectorsContract,
  customConnectorValuesContract,
} from "@okouai/api-contracts/contracts/custom-connectors";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectedConnectorsRoutes } from "../connected-connectors";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorCheckRoutes } from "../connector-check";
import { builtinConnectorsRoutes } from "../connectors";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";
import { featureSwitchesRoutes } from "../feature-switches";
import { createBddApi } from "./helpers/api-bdd";
import { createAuthDeviceApiActions } from "./helpers/api-bdd-auth-device";
import { createClaimedRunCredentials } from "./helpers/claimed-run-credentials";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const authDevice = createAuthDeviceApiActions(context);
const credentials = createClaimedRunCredentials(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const routes = Object.freeze([
  ...connectedConnectorsRoutes,
  ...builtinConnectorsRoutes,
  ...connectorAccountRoutes,
  ...customConnectorsRoutes,
  ...customConnectorsValuesSetRoutes,
  ...featureSwitchesRoutes,
]);

test("respects catalog discovery feature switches for saved accounts", async () => {
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  const app = setupApp({ context, routes });
  await accept(
    app(builtinConnectorManualGrantContract).connect({
      headers,
      params: { connectorSlug: "bentoml" },
      body: {
        authMethod: "api-token",
        account: { intent: "add" },
        values: {
          apiToken: "bento-token",
          endpoint: "https://example.bentoml.test",
        },
      },
    }),
    [200],
  );
  const switches = app(featureSwitchesContract);
  const client = app(connectedConnectorsContract);
  for (const enabled of [false, true, false]) {
    await accept(
      switches.update({
        headers,
        body: { switches: { [FeatureSwitchKey.BentomlConnector]: enabled } },
      }),
      [200],
    );
    const listed = await accept(client.list({ headers }), [200]);
    expect(listed.body.builtinConnectors).toStrictEqual(
      enabled ? [expect.objectContaining({ slug: "bentoml" })] : [],
    );
  }
});

test("requires authentication and an organization", async () => {
  const client = setupApp({ context, routes })(connectedConnectorsContract);
  expect((await client.list({ headers: {} })).status).toBe(401);
  mocks.clerk.session(`user_${randomUUID()}`, null);
  expect((await client.list({ headers })).status).toBe(401);
});

test.each(["PAT", "Run"] as const)(
  "reads the owning member's saved directory with a real %s credential",
  async (credentialType) => {
    const actor = bdd.user();
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const app = await setupApp({ context, routes, isolatePg: true });
    const client = app(connectedConnectorsContract);
    expect((await accept(client.list({ headers }), [200])).body).toStrictEqual({
      builtinConnectors: [],
      customConnectors: [],
    });

    const run =
      credentialType === "Run" ? await credentials.claim(actor) : null;
    let token: string;
    if (run) {
      token = run.token;
    } else {
      const device = await authDevice.startCliDevice();
      const approved = await authDevice.requestCliApproval(
        actor,
        { device_code: device.device_code },
        [200],
      );
      expect(approved.body).toStrictEqual({ success: true });
      const exchanged = await authDevice.requestCliToken(
        device.device_code,
        [200],
      );
      if (exchanged.status !== 200) {
        throw new Error("Expected a CLI device token");
      }
      token = exchanged.body.access_token;
    }

    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    // Saving accounts after issuance does not add them to an already claimed Run.
    await accept(
      app(builtinConnectorManualGrantContract).connect({
        headers,
        params: { connectorSlug: "gitlab" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {
            accessToken: "directory-secret",
            host: "gitlab.example.test",
          },
        },
      }),
      [200],
    );
    const custom = await accept(
      app(customConnectorsContract).create({
        headers,
        body: {
          displayName: "Saved custom connector",
          prefixTemplates: ["https://connected.example.test/"],
          fields: [],
          headerInjections: [],
          queryInjections: [],
          authMode: "none",
        },
      }),
      [201],
    );
    await accept(
      app(customConnectorValuesContract).set({
        headers,
        params: { id: custom.body.id },
        body: { values: [], account: { intent: "add" } },
      }),
      [200],
    );

    const credentialHeaders = { authorization: `Bearer ${token}` };
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const listed = await accept(
      client.list({ headers: credentialHeaders }),
      [200],
    );
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(listed.body).toStrictEqual({
      builtinConnectors: [
        {
          slug: "gitlab",
          label: expect.any(String),
          icon: expect.any(Object),
          hasPermissions: expect.any(Boolean),
        },
      ],
      customConnectors: [
        {
          id: custom.body.id,
          slug: custom.body.slug,
          displayName: "Saved custom connector",
          permissionBundleRef: null,
          integrationManaged: false,
        },
      ],
    });

    if (run) {
      const diagnostics = setupApp({ context, routes: connectorCheckRoutes })(
        connectorCheckContract,
      );
      for (const { target, url } of [
        {
          target: { kind: "builtin", connectorSlug: "gitlab" },
          url: "https://gitlab.example.test/api/v4/projects",
        },
        {
          target: { kind: "custom", customConnectorId: custom.body.id },
          url: "https://connected.example.test/items",
        },
      ] as const) {
        const checked = await accept(
          diagnostics.check({
            headers: credentialHeaders,
            body: { mode: "url", method: "GET", target, url },
          }),
          [200],
        );
        expect(checked.body).toStrictEqual({
          outcome: "target-unavailable",
          target,
          reason: "not-admitted",
        });
      }

      const sandboxOnly = await accept(
        client.list({
          headers: { authorization: `Bearer ${run.sandboxToken}` },
        }),
        [403],
      );
      expect(sandboxOnly.body.error.code).toBe("FORBIDDEN");
    }
  },
);

test("returns only saved connector briefs, independently of account defaults and other owners", async () => {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  mocks.clerk.session(userId, orgId, "org:admin");
  const app = setupApp({ context, routes });
  const client = app(connectedConnectorsContract);
  const empty = await accept(client.list({ headers }), [200]);
  expect(empty.headers.get("cache-control")).toBe("no-store");
  expect(empty.body).toStrictEqual({
    builtinConnectors: [],
    customConnectors: [],
  });
  const definition = await accept(
    app(customConnectorsContract).create({
      headers,
      body: {
        displayName: "Saved custom connector",
        prefixTemplates: ["https://connected.example.test/"],
        fields: [],
        headerInjections: [],
        queryInjections: [],
        authMode: "none",
      },
    }),
    [201],
  );
  // An organization definition alone is not a user connection.
  expect(
    (await accept(client.list({ headers }), [200])).body.customConnectors,
  ).toStrictEqual([]);
  await accept(
    app(customConnectorValuesContract).set({
      headers,
      params: { id: definition.body.id },
      body: { values: [], account: { intent: "add" } },
    }),
    [200],
  );
  const accounts = app(connectorAccountsContract);
  const builtin = app(builtinConnectorManualGrantContract);
  const first = await accept(
    builtin.connect({
      headers,
      params: { connectorSlug: "gitlab" },
      body: {
        authMethod: "api-token",
        account: { intent: "add" },
        values: {
          accessToken: "connected-secret-one",
          host: "gitlab.example.test",
        },
      },
    }),
    [200],
  );
  const second = await accept(
    builtin.connect({
      headers,
      params: { connectorSlug: "gitlab" },
      body: {
        authMethod: "api-token",
        account: { intent: "add" },
        values: {
          accessToken: "connected-secret-two",
          host: "gitlab.example.test",
        },
      },
    }),
    [200],
  );
  const listed = (await accept(client.list({ headers }), [200])).body;
  expect(listed).toStrictEqual({
    builtinConnectors: [
      {
        slug: "gitlab",
        label: expect.any(String),
        icon: expect.any(Object),
        hasPermissions: expect.any(Boolean),
      },
    ],
    customConnectors: [
      {
        id: definition.body.id,
        slug: definition.body.slug,
        displayName: "Saved custom connector",
        permissionBundleRef: null,
        integrationManaged: false,
      },
    ],
  });
  const target = { kind: "builtin" as const, connectorSlug: "gitlab" };
  await accept(
    accounts.rename({
      headers,
      params: { connectionId: second.body.id },
      body: { target, displayName: "Work" },
    }),
    [200],
  );
  await accept(
    accounts.setDefault({
      headers,
      params: { connectionId: second.body.id },
      body: { target },
    }),
    [200],
  );
  expect((await accept(client.list({ headers }), [200])).body).toStrictEqual(
    listed,
  );

  mocks.clerk.session(`user_${randomUUID()}`, orgId);
  expect((await accept(client.list({ headers }), [200])).body).toStrictEqual({
    builtinConnectors: [],
    customConnectors: [],
  });
  mocks.clerk.session(userId, `org_${randomUUID()}`);
  expect((await accept(client.list({ headers }), [200])).body).toStrictEqual({
    builtinConnectors: [],
    customConnectors: [],
  });
  mocks.clerk.session(userId, orgId, "org:admin");
  await accept(
    accounts.delete({
      headers,
      params: { connectionId: first.body.id },
      body: { target },
    }),
    [200],
  );
  expect((await accept(client.list({ headers }), [200])).body).toStrictEqual(
    listed,
  );
  await accept(
    accounts.delete({
      headers,
      params: { connectionId: second.body.id },
      body: { target },
    }),
    [200],
  );
  expect(
    (await accept(client.list({ headers }), [200])).body.builtinConnectors,
  ).toStrictEqual([]);
});
