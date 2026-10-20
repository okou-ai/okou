import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../../mocks/server";
import {
  catalogStatusItem,
  stubConnectorCatalog,
} from "../../../__tests__/helpers/connector-catalog";
import {
  customConnector,
  stubCustomConnectors,
} from "../../../__tests__/helpers/custom-connectors";
import { connectorAccountCommand } from "../index";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const CUSTOM_ID = "33333333-3333-4333-8333-333333333333";
const SECRET = "reflected-account-secret";
const builtinTarget = { kind: "builtin", connectorSlug: "github" };
const customTarget = { kind: "custom", customConnectorId: CUSTOM_ID };

function account(target: object) {
  return {
    id: ID,
    target,
    authMethod: "oauth",
    displayName: "Work",
    isDefault: true,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    clientId: SECRET,
    clientSecret: SECRET,
    password: SECRET,
    accessToken: SECRET,
  };
}

describe("connector account exact management", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    for (const command of connectorAccountCommand.commands) {
      for (const key of ["connectionId", "name", "clearName", "json"])
        command.setOptionValue(key, undefined);
    }
    server.use(
      stubConnectorCatalog([catalogStatusItem({ connectorSlug: "github" })]),
      stubCustomConnectors([customConnector()]),
    );
  });
  afterEach(() => {
    log.mockClear();
    error.mockClear();
    vi.unstubAllEnvs();
  });

  it.each([
    ["show", "GET", "", builtinTarget, "builtin:github"],
    ["show", "GET", "", customTarget, `custom:${CUSTOM_ID}`],
    ["update", "PATCH", "", builtinTarget, "builtin:github"],
    ["rename", "PATCH", "", customTarget, `custom:${CUSTOM_ID}`],
    ["set-default", "POST", "/default", builtinTarget, "builtin:github"],
    ["set-default", "POST", "/default", customTarget, `custom:${CUSTOM_ID}`],
    ["impact", "GET", "/deletion-impact", builtinTarget, "builtin:github"],
    ["delete", "DELETE", "", customTarget, `custom:${CUSTOM_ID}`],
  ] as const)(
    "%s %s %s uses an exact target",
    async (operation, method, suffix, target, selector) => {
      let received = false;
      server.use(
        http.all(
          `http://localhost:3000/api/connector-accounts/${ID}${suffix}`,
          async ({ request }) => {
            received = true;
            expect(request.method).toBe(method);
            if (method === "GET") {
              const url = new URL(request.url);
              expect(url.searchParams.get("kind")).toBe(target.kind);
              expect(
                url.searchParams.get(
                  target.kind === "builtin"
                    ? "connectorSlug"
                    : "customConnectorId",
                ),
              ).toBe(target.kind === "builtin" ? "github" : CUSTOM_ID);
            } else
              expect(await request.json()).toEqual({
                target,
                ...(operation === "update" || operation === "rename"
                  ? { displayName: "Work" }
                  : {}),
              });
            return HttpResponse.json(
              operation === "impact"
                ? {
                    connectionId: ID,
                    explicitSelectionCount: 2,
                    hasSibling: true,
                    token: SECRET,
                  }
                : operation === "delete"
                  ? {
                      deletedConnectionId: ID,
                      resolvedSelectionCount: 2,
                      promotedDefaultConnectionId: OTHER_ID,
                      token: SECRET,
                    }
                  : account(target),
            );
          },
        ),
      );
      await connectorAccountCommand.parseAsync([
        "node",
        "okou",
        operation,
        selector,
        "--connection-id",
        ID,
        "--json",
        ...(operation === "update" || operation === "rename"
          ? ["--name", "Work"]
          : []),
      ]);
      expect(received).toBe(true);
      expect(log.mock.calls.flat().join("\n")).not.toContain(SECRET);
      expect(error).not.toHaveBeenCalled();
    },
  );
});
