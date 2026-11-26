import { randomUUID } from "node:crypto";

import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { expect } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectedConnectorsRoutes } from "../connected-connectors";
import { connectorAccountRoutes } from "../connector-accounts";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createAuthDeviceApiActions } from "./helpers/api-bdd-auth-device";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

function connectionIdOf(
  body: { readonly connectionId: string } | { readonly error: unknown },
): string {
  if (!("connectionId" in body)) {
    throw new Error(
      `Expected a connected account, received ${JSON.stringify(body)}`,
    );
  }
  return body.connectionId;
}

function headersFor(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

async function readDirectory(actor: ApiTestUser) {
  const client = setupApp({ context, routes: connectedConnectorsRoutes })(
    connectedConnectorsContract,
  );
  return await accept(client.list({ headers: headersFor(actor) }), [200]);
}

async function saveGitlabAndNoAuthConnection(owner: ApiTestUser) {
  const connectors = createConnectorBddApi(context);
  const suffix = randomUUID().slice(0, 8);
  const gitlabToken = `glpat-${randomUUID()}`;
  await connectors.requestManualGrant(
    owner,
    "gitlab",
    "api-token",
    { accessToken: gitlabToken },
    { statuses: [200] },
  );
  const definition = await connectors.createCustomConnector(owner, {
    displayName: `Directory ${suffix}`,
    prefixTemplates: [`https://directory-${suffix}.example.test/`],
    authMode: "none",
    fields: [],
    headerInjections: [],
    queryInjections: [],
  });
  await connectors.setCustomConnectorValues(owner, definition.id, []);
  return { gitlabToken, definition };
}

function expectedBriefs(definition: {
  readonly id: string;
  readonly displayName: string;
}) {
  return {
    builtinConnectors: [
      expect.objectContaining({ slug: "gitlab", label: "GitLab" }),
    ],
    customConnectors: [
      expect.objectContaining({
        id: definition.id,
        displayName: definition.displayName,
        permissionBundleRef: null,
        integrationManaged: false,
      }),
    ],
  };
}

test("connected-connectors-003 shows the owner's saved connectors to the owner's CLI token", async () => {
  const bdd = createBddApi(context);
  const owner = bdd.user();
  const device = createAuthDeviceApiActions(context);
  const started = await device.startCliDevice();
  await device.requestCliApproval(
    owner,
    { device_code: started.device_code },
    [200],
  );
  const issued = await device.requestCliToken(started.device_code, [200]);
  if (issued.status !== 200) {
    throw new Error("Expected a CLI token");
  }
  const { gitlabToken, definition } =
    await saveGitlabAndNoAuthConnection(owner);

  // A different browser user is signed in while the CLI token is used.
  headersFor(bdd.user());
  const client = setupApp({ context, routes: connectedConnectorsRoutes })(
    connectedConnectorsContract,
  );
  const response = await accept(
    client.list({
      headers: { authorization: `Bearer ${issued.body.access_token}` },
    }),
    [200],
  );

  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.body).toStrictEqual(expectedBriefs(definition));
  expect(JSON.stringify(response.body)).not.toContain(gitlabToken);
});

test("connected-connectors-005 lists one brief per saved connector, independent of account defaults and other owners", async () => {
  const bdd = createBddApi(context);
  const connectors = createConnectorBddApi(context);
  const owner = bdd.user();
  const suffix = randomUUID().slice(0, 8);

  const initial = await readDirectory(owner);
  expect(initial.headers.get("cache-control")).toBe("no-store");
  expect(initial.body).toStrictEqual({
    builtinConnectors: [],
    customConnectors: [],
  });

  const definition = await connectors.createCustomConnector(owner, {
    displayName: `Directory ${suffix}`,
    prefixTemplates: [`https://directory-${suffix}.example.test/`],
    authMode: "none",
    fields: [],
    headerInjections: [],
    queryInjections: [],
  });
  const definitionOnly = await readDirectory(owner);
  expect(definitionOnly.body).toStrictEqual(initial.body);

  await connectors.setCustomConnectorValues(owner, definition.id, []);
  const gitlabTarget = { kind: "builtin", connectorSlug: "gitlab" } as const;
  const firstGitlab = await connectors.requestManualGrant(
    owner,
    "gitlab",
    "api-token",
    { accessToken: `glpat-${randomUUID()}` },
    { statuses: [200] },
  );
  const secondGitlab = await connectors.requestManualGrant(
    owner,
    "gitlab",
    "api-token",
    { accessToken: `glpat-${randomUUID()}` },
    { statuses: [200] },
  );

  const saved = await readDirectory(owner);
  expect(saved.body.builtinConnectors).toStrictEqual([
    expect.objectContaining({ slug: "gitlab", label: "GitLab" }),
  ]);
  expect(saved.body.customConnectors).toStrictEqual([
    expect.objectContaining({
      id: definition.id,
      displayName: `Directory ${suffix}`,
    }),
  ]);

  const accounts = setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
  await accept(
    accounts.rename({
      headers: headersFor(owner),
      params: { connectionId: connectionIdOf(secondGitlab.body) },
      body: { target: gitlabTarget, displayName: "Work GitLab" },
    }),
    [200],
  );
  await connectors.setDefaultBuiltinConnectorAccount(
    owner,
    "gitlab",
    connectionIdOf(secondGitlab.body),
  );

  const sameOrgMember = bdd.user({
    orgId: owner.orgId,
    orgRole: "org:member",
  });
  const ownerElsewhere = bdd.user({ userId: owner.userId });
  for (const other of [sameOrgMember, ownerElsewhere]) {
    expect((await readDirectory(other)).body).toStrictEqual(initial.body);
  }

  await connectors.deleteBuiltinConnectorAccount(
    owner,
    "gitlab",
    connectionIdOf(secondGitlab.body),
  );
  // Rename, default switch and deleting one of two accounts leave the briefs.
  expect((await readDirectory(owner)).body).toStrictEqual(saved.body);

  await connectors.deleteBuiltinConnectorAccount(
    owner,
    "gitlab",
    connectionIdOf(firstGitlab.body),
  );
  const afterLast = await readDirectory(owner);
  expect(afterLast.body.builtinConnectors).toStrictEqual([]);
  expect(afterLast.body.customConnectors).toStrictEqual(
    saved.body.customConnectors,
  );
});
