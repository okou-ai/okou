import { randomUUID } from "node:crypto";

import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  builtinConnectorManualGrantContract,
  builtinConnectorNoAuthGrantContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  customConnectorByIdContract,
  customConnectorOAuth2Contract,
  customConnectorValuesContract,
  customConnectorsContract,
  type CreateCustomConnectorBody,
  type CustomConnectorValueInput,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsGetRoutes } from "../custom-connectors-get";
import { customConnectorOAuth2Routes } from "../custom-connectors-oauth2";
import { customConnectorsUpdateRoutes } from "../custom-connectors-update";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";
import {
  manualHttpCustomConnectorCreateBody,
  mockCustomConnectorOAuth2Provider,
} from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "org:admin" | "org:member";
}

function newActor(
  role: Actor["role"] = "org:admin",
  orgId = `org_${randomUUID()}`,
): Actor {
  return { userId: `user_${randomUUID()}`, orgId, role };
}

function as(actor: Actor) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.role,
  );
  return { authorization: "Bearer clerk-session" };
}

function accounts() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

const OPENAI: ConnectorAccountTarget = Object.freeze({
  kind: "builtin",
  connectorSlug: "openai",
});
const GITHUB: ConnectorAccountTarget = Object.freeze({
  kind: "builtin",
  connectorSlug: "github",
});
const PUBLIC_MCP: ConnectorAccountTarget = Object.freeze({
  kind: "builtin",
  connectorSlug: "public-mcp",
});

function custom(customConnectorId: string): ConnectorAccountTarget {
  return { kind: "custom", customConnectorId };
}

async function addOpenAiAccount(
  actor: Actor,
  apiKey: string,
  displayName?: string,
) {
  const client = setupApp({ context, routes: builtinConnectorsRoutes })(
    builtinConnectorManualGrantContract,
  );
  const response = await accept(
    client.connect({
      params: { connectorSlug: "openai" },
      headers: as(actor),
      body: {
        authMethod: "api-token",
        values: { apiKey },
        account:
          displayName === undefined
            ? { intent: "add" }
            : { intent: "add", displayName },
      },
    }),
    [200],
  );
  return response.body.connectionId;
}

async function addPublicMcpAccount(actor: Actor) {
  const client = setupApp({ context, routes: builtinConnectorsRoutes })(
    builtinConnectorNoAuthGrantContract,
  );
  const response = await accept(
    client.connect({
      params: { connectorSlug: "public-mcp" },
      headers: as(actor),
      body: { authMethod: "none", account: { intent: "add" } },
    }),
    [200],
  );
  return response.body.connectionId;
}

async function createCustomConnector(
  actor: Actor,
  body: CreateCustomConnectorBody,
) {
  const client = setupApp({ context, routes: customConnectorsRoutes })(
    customConnectorsContract,
  );
  const response = await accept(
    client.create({ headers: as(actor), body }),
    [201],
  );
  return response.body;
}

async function addCustomAccount(
  actor: Actor,
  connectorId: string,
  values: readonly CustomConnectorValueInput[],
  displayName?: string,
  reconnect?: string,
) {
  const client = setupApp({
    context,
    routes: customConnectorsValuesSetRoutes,
  })(customConnectorValuesContract);
  const response = await accept(
    client.set({
      params: { id: connectorId },
      headers: as(actor),
      body: {
        values: [...values],
        account:
          reconnect !== undefined
            ? { intent: "reconnect", connectionId: reconnect }
            : displayName === undefined
              ? { intent: "add" }
              : { intent: "add", displayName },
      },
    }),
    [200],
  );
  return response.body.connectionId;
}

async function listAccounts(
  actor: Actor,
  target: ConnectorAccountTarget,
  options: { readonly limit?: number; readonly search?: string } = {},
) {
  const query =
    target.kind === "builtin"
      ? { kind: "builtin" as const, connectorSlug: target.connectorSlug }
      : {
          kind: "custom" as const,
          customConnectorId: target.customConnectorId,
        };
  const response = await accept(
    accounts().connections({
      headers: as(actor),
      query: { ...query, limit: options.limit ?? 100, search: options.search },
    }),
    [200],
  );
  return response.body;
}

async function readAccount(
  actor: Actor,
  target: ConnectorAccountTarget,
  connectionId: string,
) {
  return await accept(
    accounts().connection({
      headers: as(actor),
      params: { connectionId },
      query: target,
    }),
    [200, 404],
  );
}

async function rename(
  actor: Actor,
  target: ConnectorAccountTarget,
  connectionId: string,
  displayName: string | null,
) {
  return await accept(
    accounts().rename({
      headers: as(actor),
      params: { connectionId },
      body: { target, displayName },
    }),
    [200, 404],
  );
}

async function setDefault(
  actor: Actor,
  target: ConnectorAccountTarget,
  connectionId: string,
) {
  return await accept(
    accounts().setDefault({
      headers: as(actor),
      params: { connectionId },
      body: { target },
    }),
    [200, 404],
  );
}

async function deletionImpact(
  actor: Actor,
  target: ConnectorAccountTarget,
  connectionId: string,
) {
  return await accept(
    accounts().deletionImpact({
      headers: as(actor),
      params: { connectionId },
      query: target,
    }),
    [200, 404],
  );
}

async function deleteAccount(
  actor: Actor,
  target: ConnectorAccountTarget,
  connectionId: string,
) {
  const response = await accept(
    accounts().delete({
      headers: as(actor),
      params: { connectionId },
      body: { target },
    }),
    [200],
  );
  return response.body;
}

async function inspect(
  headers: { readonly authorization: string },
  selections: readonly {
    readonly connectionId: string;
    readonly target: ConnectorAccountTarget;
  }[],
) {
  const response = await accept(
    accounts().inspect({ headers, body: { selections: [...selections] } }),
    [200],
  );
  return response.body.results;
}

function ids(connections: readonly ConnectorAccountConnection[]) {
  return connections.map((connection) => {
    return connection.id;
  });
}

const NOT_FOUND = Object.freeze({
  error: { code: "NOT_FOUND", message: "Connector account not found" },
});

describe("connector account lifecycle routes", () => {
  it("connector-accounts-022 projects a no-auth custom HTTP account as connected", async () => {
    const owner = newActor();
    const connector = await createCustomConnector(owner, {
      displayName: "Public HTTP",
      prefixTemplates: [`https://${randomUUID()}.example.test/api`],
      authMode: "none",
      fields: [],
      headerInjections: [],
      queryInjections: [],
    });
    const target = custom(connector.id);

    const id = await addCustomAccount(owner, connector.id, []);
    const list = await listAccounts(owner, target);
    const exact = await readAccount(owner, target, id);

    expect(ids(list.connections)).toStrictEqual([id]);
    expect(list.defaultConnection).toMatchObject({
      id,
      isDefault: true,
      connectionStatus: "connected",
      authMethod: "none",
      reconnectReason: null,
      missingRequiredFields: [],
      configuredFieldKeys: [],
    });
    expect(exact.status).toBe(200);
    expect(exact.body).toStrictEqual(list.defaultConnection);
  });

  it("connector-accounts-021 does not enumerate or mutate another member account", async () => {
    const owner = newActor("org:member");
    const peer = newActor("org:member", owner.orgId);
    const outsider = newActor();
    const id = await addOpenAiAccount(owner, `sk-${randomUUID()}`);
    const selection = { connectionId: id, target: OPENAI };

    const search = await listAccounts(peer, OPENAI, {
      search: id.slice(0, 8),
    });
    expect(search.connections).toStrictEqual([]);
    expect((await readAccount(peer, OPENAI, id)).status).toBe(404);
    expect((await rename(peer, OPENAI, id, "Mine")).status).toBe(404);
    await expect(inspect(as(peer), [selection])).resolves.toStrictEqual([
      { kind: "unavailable", ...selection },
    ]);
    await expect(inspect(as(outsider), [selection])).resolves.toStrictEqual([
      { kind: "unavailable", ...selection },
    ]);
  });

  it("connector-accounts-002 keeps OAuth custom accounts exact through a non-default reconnect", async () => {
    const owner = newActor();
    const provider = mockCustomConnectorOAuth2Provider(context);
    const clientSecret = `client-secret-${randomUUID()}`;
    const definition = {
      displayName: "OAuth HTTP",
      prefixTemplates: [`https://${randomUUID()}.example.test/api`],
      authMode: "oauth" as const,
      fields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      queryInjections: [],
      oauthConfig: {
        providerAdapter: "standard" as const,
        clientId: "branded-oauth-client-id",
        clientSecret,
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        tokenEndpointAuthMethod: "client_secret_post" as const,
        pkceMethod: "S256" as const,
        scopes: ["read"],
        authorizationParams: {},
      },
    };
    const connector = await createCustomConnector(owner, definition);
    const target = custom(connector.id);
    const oauth = setupApp({ context, routes: customConnectorOAuth2Routes })(
      customConnectorOAuth2Contract,
    );
    async function authorize(
      account:
        | { readonly intent: "add"; readonly displayName?: string }
        | { readonly intent: "reconnect"; readonly connectionId: string },
    ) {
      const start = await accept(
        oauth.start({
          headers: as(owner),
          params: { id: connector.id },
          body: { account },
        }),
        [200],
      );
      if (start.body.result !== "authorization") {
        throw new Error("Expected an OAuth authorization URL");
      }
      const state = new URL(start.body.authorizationUrl).searchParams.get(
        "state",
      );
      const callback = await accept(
        oauth.callback({
          query: {
            code: `code-${randomUUID()}`,
            state: state ?? "",
            responseMode: "json",
          },
        }),
        [200],
      );
      expect(callback.body.status).toBe("success");
    }

    await authorize({ intent: "add" });
    await authorize({ intent: "add", displayName: "Second" });
    const before = await listAccounts(owner, target);
    const firstAccount = before.connections.find((connection) => {
      return connection.isDefault;
    });
    const secondAccount = before.connections.find((connection) => {
      return !connection.isDefault;
    });
    expect(before.connections).toHaveLength(2);
    for (const account of [firstAccount, secondAccount]) {
      expect(account).toMatchObject({
        connectionStatus: "connected",
        configuredFieldKeys: [],
        missingRequiredFields: [],
      });
    }
    expect(secondAccount?.displayName).toBe("Second");
    expect(JSON.stringify(before)).not.toContain(clientSecret);

    const addField = await accept(
      setupApp({ context, routes: customConnectorsUpdateRoutes })(
        customConnectorByIdContract,
      ).update({
        headers: as(owner),
        params: { id: connector.id },
        body: {
          ...definition,
          fields: [
            {
              key: "region",
              label: "Region",
              kind: "variable",
              required: true,
            },
          ],
        },
      }),
      [400],
    );
    expect(addField.body.error.message).toContain(
      "remove all fields and their template references",
    );

    await authorize({
      intent: "reconnect",
      connectionId: secondAccount?.id ?? "",
    });
    const after = await listAccounts(owner, target);
    expect(new Set(ids(after.connections))).toStrictEqual(
      new Set(ids(before.connections)),
    );
    expect(after.defaultConnection?.id).toBe(firstAccount?.id);

    const manual = await accept(
      setupApp({ context, routes: customConnectorsValuesSetRoutes })(
        customConnectorValuesContract,
      ).set({
        params: { id: connector.id },
        headers: as(owner),
        body: {
          values: [],
          account: {
            intent: "reconnect",
            connectionId: secondAccount?.id ?? "",
          },
        },
      }),
      [400],
    );
    expect(manual.body.error.message).toContain("authentication discovery");
  });

  it("connector-accounts-003 keeps a stale default beside a reconnected healthy custom sibling", async () => {
    const owner = newActor();
    const definition = {
      displayName: "Regional HTTP",
      prefixTemplates: [`https://${randomUUID()}.example.test/api`],
      fields: [
        {
          key: "api_key",
          label: "API key",
          kind: "secret" as const,
          required: true,
        },
        {
          key: "region",
          label: "Region",
          kind: "variable" as const,
          required: true,
        },
      ],
      headerInjections: [
        { name: "Authorization", valueTemplate: "Bearer {{secrets.api_key}}" },
        { name: "X-Region", valueTemplate: "{{variables.region}}" },
      ],
      queryInjections: [],
    };
    const connector = await createCustomConnector(owner, definition);
    const target = custom(connector.id);
    const values = (suffix: string): CustomConnectorValueInput[] => {
      return [
        { key: "api_key", kind: "secret", value: `key-${suffix}` },
        { key: "region", kind: "variable", value: `region-${suffix}` },
      ];
    };
    const stale = await addCustomAccount(owner, connector.id, values("a"));
    const second = await addCustomAccount(owner, connector.id, values("b"));

    const initial = await readAccount(owner, target, second);
    expect(initial.body).toMatchObject({
      connectionStatus: "connected",
      missingRequiredFields: [],
    });
    expect(
      initial.status === 200
        ? [...initial.body.configuredFieldKeys].sort()
        : [],
    ).toStrictEqual(["api_key", "region"]);

    await accept(
      setupApp({ context, routes: customConnectorsUpdateRoutes })(
        customConnectorByIdContract,
      ).update({
        headers: as(owner),
        params: { id: connector.id },
        body: { ...definition, storageVersion: 2 },
      }),
      [200],
    );
    const staleDefault = await readAccount(owner, target, stale);
    expect(staleDefault.body).toMatchObject({
      isDefault: true,
      connectionStatus: "reconnect-required",
      reconnectReason: "configuration_invalid",
      configuredFieldKeys: [],
    });
    expect(
      staleDefault.status === 200
        ? [...staleDefault.body.missingRequiredFields].sort()
        : [],
    ).toStrictEqual(["api_key", "region"]);

    const reconnected = await addCustomAccount(
      owner,
      connector.id,
      values("c"),
      undefined,
      second,
    );
    expect(reconnected).toBe(second);
    const list = await listAccounts(owner, target);
    expect(new Set(ids(list.connections))).toStrictEqual(
      new Set([stale, second]),
    );
    expect(list.defaultConnection).toMatchObject({
      id: stale,
      connectionStatus: "reconnect-required",
    });
    const healthy = list.connections.find((connection) => {
      return connection.id === second;
    });
    expect(healthy).toMatchObject({
      connectionStatus: "connected",
      missingRequiredFields: [],
    });
    expect([...(healthy?.configuredFieldKeys ?? [])].sort()).toStrictEqual([
      "api_key",
      "region",
    ]);
    expect(JSON.stringify([list, initial.body])).not.toMatch(/key-|region-/);
  });

  it("connector-accounts-007 keeps default transitions exact and isolated across custom targets", async () => {
    const owner = newActor();
    const prefix = `https://${randomUUID()}.example.test/api`;
    const first = await createCustomConnector(
      owner,
      manualHttpCustomConnectorCreateBody({
        displayName: "First",
        prefixTemplates: [prefix],
      }),
    );
    const second = await createCustomConnector(
      owner,
      manualHttpCustomConnectorCreateBody({
        displayName: "Second",
        prefixTemplates: [prefix],
      }),
    );
    const firstTarget = custom(first.id);
    const secondTarget = custom(second.id);
    const add = (connectorId: string, name: string) => {
      return addCustomAccount(
        owner,
        connectorId,
        [{ key: "secret", kind: "secret", value: `secret-${name}` }],
        name,
      );
    };
    const work = await add(first.id, "Work");
    const personal = await add(first.id, "Personal");
    const removed = await add(first.id, "Removed");
    const other = await add(second.id, "Other");

    const mismatched = await setDefault(owner, secondTarget, personal);
    expect(mismatched.status).toBe(404);
    expect(mismatched.body).toStrictEqual(NOT_FOUND);
    await expect(
      deleteAccount(owner, firstTarget, removed),
    ).resolves.toStrictEqual({
      deletedConnectionId: removed,
      resolvedSelectionCount: 0,
      promotedDefaultConnectionId: null,
    });
    const deletedDefault = await setDefault(owner, firstTarget, removed);
    expect(deletedDefault.status).toBe(404);
    expect(deletedDefault.body).toStrictEqual(NOT_FOUND);

    const search = await listAccounts(owner, firstTarget, {
      search: "Personal",
      limit: 1,
    });
    expect(ids(search.connections)).toStrictEqual([personal]);
    expect(search.defaultConnection?.id).toBe(work);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const changed = await setDefault(owner, firstTarget, personal);
      expect(changed.body).toMatchObject({ id: personal, isDefault: true });
    }
    const expectList = async (
      target: ConnectorAccountTarget,
      expected: readonly string[],
      defaultId: string,
    ) => {
      const list = await listAccounts(owner, target);
      expect(new Set(ids(list.connections))).toStrictEqual(new Set(expected));
      expect(
        list.connections
          .filter((connection) => {
            return connection.isDefault;
          })
          .map((connection) => {
            return connection.id;
          }),
      ).toStrictEqual([defaultId]);
      expect(JSON.stringify(list)).not.toContain("secret-");
    };
    await expectList(firstTarget, [work, personal], personal);

    await expect(
      deleteAccount(owner, firstTarget, personal),
    ).resolves.toStrictEqual({
      deletedConnectionId: personal,
      resolvedSelectionCount: 0,
      promotedDefaultConnectionId: work,
    });
    await expectList(secondTarget, [other], other);
  });

  it("connector-accounts-004 inspects duplicate selections in order through rename and deletion", async () => {
    const owner = newActor();
    const id = await addOpenAiAccount(owner, `sk-${randomUUID()}`);
    await rename(owner, OPENAI, id, "Work");
    const unknown = randomUUID();
    const selections = [
      { connectionId: unknown, target: OPENAI },
      { connectionId: id, target: OPENAI },
      { connectionId: id, target: GITHUB },
      { connectionId: id, target: OPENAI },
    ];

    const initial = await inspect(as(owner), selections);
    const available = {
      kind: "available",
      connectionId: id,
      target: OPENAI,
      authMethod: "api-token",
      displayName: "Work",
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      connectionStatus: "connected",
      reconnectReason: null,
      missingRequiredFields: [],
      configuredFieldKeys: ["apiKey"],
    };
    expect(initial).toStrictEqual([
      { kind: "unavailable", ...selections[0] },
      available,
      { kind: "unavailable", ...selections[2] },
      available,
    ]);
    expect(JSON.stringify(initial)).not.toContain("sk-");

    await rename(owner, OPENAI, id, "Renamed");
    const renamed = await inspect(as(owner), selections);
    expect(renamed[1]).toMatchObject({ displayName: "Renamed" });
    expect(renamed[3]).toMatchObject({ displayName: "Renamed" });

    const deleted = await deleteAccount(owner, OPENAI, id);
    expect(deleted.deletedConnectionId).toBe(id);
    const afterDelete = await inspect(as(owner), selections);
    expect(
      afterDelete.map((result) => {
        return result.kind;
      }),
    ).toStrictEqual([
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
  });

  it("connector-accounts-009 manages sibling defaults, pagination, search and deletion", async () => {
    const owner = newActor();
    const work = await addOpenAiAccount(owner, `sk-${randomUUID()}`, "Work");
    const first = await listAccounts(owner, OPENAI);
    expect(ids(first.connections)).toStrictEqual([work]);
    expect(first.nextCursor).toBeNull();
    expect(first.defaultConnection).toMatchObject({
      id: work,
      displayName: "Work",
      isDefault: true,
    });
    const soleImpact = await deletionImpact(owner, OPENAI, work);
    expect(soleImpact.body).toStrictEqual({
      connectionId: work,
      explicitSelectionCount: 0,
      hasSibling: false,
    });

    const personal = await addOpenAiAccount(owner, `sk-${randomUUID()}`);
    const page1 = await listAccounts(owner, OPENAI, { limit: 1 });
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await accept(
      accounts().connections({
        headers: as(owner),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
          limit: 1,
          cursor: page1.nextCursor ?? "",
        },
      }),
      [200],
    );
    expect(
      new Set([...ids(page1.connections), ...ids(page2.body.connections)]),
    ).toStrictEqual(new Set([work, personal]));
    expect(page1.defaultConnection?.id).toBe(work);
    expect(page2.body.defaultConnection?.id).toBe(work);
    expect((await readAccount(owner, GITHUB, personal)).status).toBe(404);

    const before = await listAccounts(owner, OPENAI, { search: "Personal" });
    expect(before.connections).toStrictEqual([]);
    expect(before.defaultConnection?.id).toBe(work);

    await rename(owner, OPENAI, personal, "Personal");
    const promoted = await setDefault(owner, OPENAI, personal);
    expect(promoted.body).toMatchObject({ id: personal, isDefault: true });
    const found = await listAccounts(owner, OPENAI, { search: "Personal" });
    expect(ids(found.connections)).toStrictEqual([personal]);
    expect(found.nextCursor).toBeNull();
    for (const id of [work, personal]) {
      expect((await deletionImpact(owner, OPENAI, id)).body).toStrictEqual({
        connectionId: id,
        explicitSelectionCount: 0,
        hasSibling: true,
      });
    }

    await expect(deleteAccount(owner, OPENAI, personal)).resolves.toStrictEqual(
      {
        deletedConnectionId: personal,
        resolvedSelectionCount: 0,
        promotedDefaultConnectionId: work,
      },
    );
    expect((await readAccount(owner, OPENAI, personal)).status).toBe(404);
    expect((await deletionImpact(owner, OPENAI, personal)).status).toBe(404);
    for (const search of [undefined, "Work"]) {
      const page = await listAccounts(owner, OPENAI, { search });
      expect(ids(page.connections)).toStrictEqual([work]);
      expect(page.defaultConnection?.id).toBe(work);
      expect(page.nextCursor).toBeNull();
    }
    expect((await deletionImpact(owner, OPENAI, work)).body).toMatchObject({
      hasSibling: false,
    });
  });

  it("connector-accounts-010 renames only exact owned built-in accounts", async () => {
    const owner = newActor();
    const peer = newActor("org:admin", owner.orgId);
    const id = await addOpenAiAccount(owner, `sk-${randomUUID()}`);
    const original = await readAccount(owner, OPENAI, id);
    expect(original.status).toBe(200);
    expect((await deletionImpact(owner, OPENAI, id)).body).toStrictEqual({
      connectionId: id,
      explicitSelectionCount: 0,
      hasSibling: false,
    });

    const rejected = [
      await rename(peer, OPENAI, id, "Stolen"),
      await deletionImpact(peer, OPENAI, id),
      await rename(peer, OPENAI, randomUUID(), "Stolen"),
      await deletionImpact(peer, OPENAI, randomUUID()),
      await rename(owner, OPENAI, randomUUID(), "Missing"),
      await rename(owner, custom(randomUUID()), id, "Wrong"),
      await rename(owner, GITHUB, id, "Wrong"),
    ];
    for (const response of rejected) {
      expect(response.status).toBe(404);
      expect(response.body).toStrictEqual(NOT_FOUND);
    }
    expect((await readAccount(owner, OPENAI, id)).body).toStrictEqual(
      original.body,
    );

    const renamed = await rename(owner, OPENAI, id, "Renamed");
    expect(renamed.status).toBe(200);
    expect((await readAccount(owner, OPENAI, id)).body).toMatchObject({
      displayName: "Renamed",
    });
    expect((await rename(owner, OPENAI, id, null)).status).toBe(200);
    expect((await readAccount(owner, OPENAI, id)).body).toMatchObject({
      displayName: null,
    });
  });

  it("connector-accounts-017 returns the default account outside the requested page", async () => {
    const owner = newActor();
    await addPublicMcpAccount(owner);
    await addPublicMcpAccount(owner);
    await addPublicMcpAccount(owner);
    const all = await listAccounts(owner, PUBLIC_MCP);
    const [first, , third] = ids(all.connections);
    await setDefault(owner, PUBLIC_MCP, third ?? "");
    const offPage = (await readAccount(owner, PUBLIC_MCP, third ?? "")).body;
    expect(offPage).toMatchObject({ id: third, isDefault: true });

    const response = await accept(
      accounts().connections({
        headers: as(owner),
        query: {
          kind: "builtin",
          connectorSlug: "public-mcp",
          limit: 1,
          includeScopeMismatch: "true",
        },
      }),
      [200],
    );

    expect(ids(response.body.connections)).toStrictEqual([first]);
    expect(response.body.nextCursor).not.toBeNull();
    expect(response.body.defaultConnection).toMatchObject(offPage);
  });

  it("connector-accounts-024 supports the exact lifecycle of custom HTTP accounts", async () => {
    const owner = newActor();
    const connector = await createCustomConnector(
      owner,
      manualHttpCustomConnectorCreateBody({
        displayName: "Manual HTTP",
        prefixTemplates: [`https://${randomUUID()}.example.test/api`],
      }),
    );
    const target = custom(connector.id);
    const secrets = [`unnamed-${randomUUID()}`, `personal-${randomUUID()}`];
    const unnamed = await addCustomAccount(owner, connector.id, [
      { key: "secret", kind: "secret", value: secrets[0] ?? "" },
    ]);
    const personal = await addCustomAccount(
      owner,
      connector.id,
      [{ key: "secret", kind: "secret", value: secrets[1] ?? "" }],
      "Personal",
    );
    const definitions = setupApp({
      context,
      routes: [...customConnectorsRoutes, ...customConnectorsGetRoutes],
    });
    async function readDefinitions() {
      const detail = await accept(
        definitions(customConnectorByIdContract).get({
          headers: as(owner),
          params: { id: connector.id },
        }),
        [200],
      );
      const list = await accept(
        definitions(customConnectorsContract).list({ headers: as(owner) }),
        [200],
      );
      expect(detail.body.id).toBe(connector.id);
      expect(
        list.body.connectors.map((entry) => {
          return entry.id;
        }),
      ).toContain(connector.id);
      for (const body of [detail.body, list.body]) {
        for (const secret of secrets) {
          expect(JSON.stringify(body)).not.toContain(secret);
        }
      }
    }

    const initial = await listAccounts(owner, target);
    expect(new Set(ids(initial.connections))).toStrictEqual(
      new Set([unnamed, personal]),
    );
    expect(
      initial.connections.filter((connection) => {
        return connection.isDefault;
      }),
    ).toHaveLength(1);
    const detail = await readAccount(owner, target, unnamed);
    expect(detail.body).toMatchObject({
      id: unnamed,
      authMethod: "manual",
      connectionStatus: "connected",
      configuredFieldKeys: ["secret"],
      missingRequiredFields: [],
    });
    const [inspected] = await inspect(as(owner), [
      { connectionId: unnamed, target },
    ]);
    expect(inspected).toMatchObject({
      kind: "available",
      authMethod: "manual",
      connectionStatus: "connected",
      configuredFieldKeys: ["secret"],
      missingRequiredFields: [],
    });
    const fallback = await listAccounts(owner, target, {
      search: unnamed.slice(0, 8),
    });
    expect(ids(fallback.connections)).toContain(unnamed);
    await readDefinitions();

    expect(
      (await rename(owner, target, personal, "Personal Renamed")).body,
    ).toMatchObject({ id: personal, displayName: "Personal Renamed" });
    await setDefault(owner, target, personal);
    const switched = await listAccounts(owner, target);
    expect(switched.defaultConnection).toMatchObject({
      id: personal,
      displayName: "Personal Renamed",
    });
    await readDefinitions();
    expect((await deletionImpact(owner, target, personal)).body).toStrictEqual({
      connectionId: personal,
      explicitSelectionCount: 0,
      hasSibling: true,
    });

    await expect(deleteAccount(owner, target, personal)).resolves.toStrictEqual(
      {
        deletedConnectionId: personal,
        resolvedSelectionCount: 0,
        promotedDefaultConnectionId: unnamed,
      },
    );
    await deleteAccount(owner, target, unnamed);
    expect((await listAccounts(owner, target)).connections).toStrictEqual([]);
  });
});
