import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import {
  catalogStatusItem,
  manualAuthMethod,
  stubConnectorCatalogStatus,
} from "../../__tests__/helpers/connector-catalog";
import {
  customConnector,
  customMcpConnector,
  stubCustomConnectors,
} from "../../__tests__/helpers/custom-connectors";
import { connectCommand } from "../connect";
import {
  stubConnectorAccountSummaries,
  stubConnectorAccountDetails,
} from "../../__tests__/helpers/connector-accounts";

const ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "input-credential-must-not-appear";

describe("connector connect safe input and custom member accounts", () => {
  let directory: string;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "connector-input-"));
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    server.use(
      stubConnectorAccountSummaries([]),
      stubConnectorAccountDetails(),
    );
    for (const key of [
      "add",
      "reconnect",
      "accountName",
      "authMethod",
      "json",
      "input",
    ])
      connectCommand.setOptionValue(key, undefined);
    connectCommand.setOptionValueWithSource("value", [], "default");
    server.use(
      stubConnectorCatalogStatus([
        catalogStatusItem({
          connectorSlug: "openai",
          authMethods: [manualAuthMethod("api-token")],
        }),
      ]),
      stubCustomConnectors([]),
    );
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    log.mockClear();
    vi.unstubAllEnvs();
  });

  function input(text: string) {
    const path = join(directory, "credentials.json");
    writeFileSync(path, text);
    return path;
  }

  it("reads builtin credentials from a file and strips additional response secrets", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/connectors/openai/manual-grant",
        async ({ request }) => {
          expect(await request.json()).toEqual({
            authMethod: "api-token",
            account: { intent: "add" },
            values: { apiKey: SECRET },
          });
          return HttpResponse.json({
            id: ID,
            slug: "openai",
            authMethod: "api-token",
            externalId: null,
            externalUsername: null,
            externalEmail: null,
            oauthScopes: null,
            connectionStatus: "connected",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            clientSecret: SECRET,
            token: SECRET,
            sessionToken: SECRET,
          });
        },
      ),
    );
    await connectCommand.parseAsync([
      "node",
      "okou",
      "builtin:openai",
      "--add",
      "--input",
      input(JSON.stringify({ apiKey: SECRET })),
      "--json",
    ]);
    const output = log.mock.calls.flat().join("\n");
    expect(JSON.parse(output)).toMatchObject({ id: ID, slug: "openai" });
    expect(output).not.toContain(SECRET);
  });

  it("reads custom credentials from stdin without displaying them", async () => {
    const connector = customConnector();
    const stdin = vi
      .spyOn(process.stdin, Symbol.asyncIterator)
      .mockImplementation(async function* () {
        yield Buffer.from(JSON.stringify({ apiKey: SECRET }));
        return undefined;
      });
    server.use(
      stubCustomConnectors([connector]),
      http.get(
        `http://localhost:3000/api/custom-connectors/${connector.id}`,
        () => {
          return HttpResponse.json(connector);
        },
      ),
      http.put(
        `http://localhost:3000/api/custom-connectors/${connector.id}/values`,
        async ({ request }) => {
          expect(await request.json()).toEqual({
            account: { intent: "add" },
            values: [{ key: "apiKey", kind: "secret", value: SECRET }],
          });
          return HttpResponse.json({
            ...connector,
            connected: true,
            connectedAccountId: ID,
          });
        },
      ),
    );
    try {
      await connectCommand.parseAsync([
        "node",
        "okou",
        `custom:${connector.id}`,
        "--add",
        "--input",
        "-",
        "--json",
      ]);
      expect(log.mock.calls.flat().join("\n")).not.toContain(SECRET);
    } finally {
      stdin.mockRestore();
    }
  });

  it.each([customConnector(), customMcpConnector()])(
    "updates manual $kind account credentials with exact member identity",
    async (connector) => {
      server.use(
        stubCustomConnectors([connector]),
        http.get(
          `http://localhost:3000/api/custom-connectors/${connector.id}`,
          () => {
            return HttpResponse.json(connector);
          },
        ),
        http.put(
          `http://localhost:3000/api/custom-connectors/${connector.id}/values`,
          async ({ request }) => {
            expect(await request.json()).toEqual({
              account: { intent: "reconnect", connectionId: ID },
              values: [{ key: "apiKey", kind: "secret", value: SECRET }],
            });
            return HttpResponse.json({
              ...connector,
              connected: true,
              connectedAccountId: ID,
              values: [{ key: "apiKey", value: SECRET }],
              password: SECRET,
            });
          },
        ),
      );
      await connectCommand.parseAsync([
        "node",
        "okou",
        `custom:${connector.id}`,
        "--reconnect",
        ID,
        "--input",
        input(JSON.stringify({ apiKey: SECRET })),
        "--json",
      ]);
      const output = log.mock.calls.flat().join("\n");
      expect(JSON.parse(output)).toMatchObject({
        connectedAccountId: ID,
        kind: connector.kind,
      });
      expect(output).not.toContain(SECRET);
    },
  );

  it.each([
    customConnector({ authMode: "none", fields: [], headerInjections: [] }),
    customMcpConnector({ authMode: "none", fields: [], headerInjections: [] }),
  ])("connects no-auth $kind accounts with empty values", async (connector) => {
    server.use(
      stubCustomConnectors([connector]),
      http.get(
        `http://localhost:3000/api/custom-connectors/${connector.id}`,
        () => {
          return HttpResponse.json(connector);
        },
      ),
      http.put(
        `http://localhost:3000/api/custom-connectors/${connector.id}/values`,
        async ({ request }) => {
          expect(await request.json()).toEqual({
            account: { intent: "add" },
            values: [],
          });
          return HttpResponse.json({
            ...connector,
            connected: true,
            connectedAccountId: ID,
          });
        },
      ),
    );
    await connectCommand.parseAsync([
      "node",
      "okou",
      `custom:${connector.id}`,
      "--add",
      "--json",
    ]);
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toMatchObject({
      connected: true,
    });
  });
});
