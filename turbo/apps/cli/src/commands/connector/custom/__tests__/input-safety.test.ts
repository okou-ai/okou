import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../../mocks/server";
import { customConnector } from "../../../__tests__/helpers/custom-connectors";
import { createCustomConnectorCommand } from "../create";
import { updateCustomConnectorCommand } from "../update";

const SECRET = "definition-input-secret";
const connector = customConnector();
const definition = {
  displayName: "Acme",
  authMode: "oauth",
  prefixTemplates: ["https://api.acme.example/"],
  fields: [],
  headerInjections: [
    { name: "Authorization", valueTemplate: "Bearer {{oauth.access_token}}" },
  ],
  queryInjections: [],
  oauthConfig: {
    providerAdapter: "standard",
    clientId: "oauth-client-id",
    clientSecret: SECRET,
    authorizationUrl: "https://provider.example/authorize",
    tokenUrl: "https://provider.example/token",
    tokenEndpointAuthMethod: "client_secret_post",
    pkceMethod: "S256",
    scopes: [],
    authorizationParams: {},
  },
};

describe("custom connector definition secret input", () => {
  let directory: string;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "connector-definition-"));
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    for (const command of [
      createCustomConnectorCommand,
      updateCustomConnectorCommand,
    ]) {
      command.setOptionValue("json", undefined);
      command.setOptionValue("file", undefined);
    }
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    log.mockClear();
    error.mockClear();
    exit.mockClear();
    vi.unstubAllEnvs();
  });

  it.each([createCustomConnectorCommand, updateCustomConnectorCommand])(
    "$name rejects invalid JSON without reflecting secrets",
    async (command) => {
      const path = join(directory, "invalid.json");
      writeFileSync(path, `{"clientSecret":"${SECRET}"`);
      await expect(
        command.parseAsync([
          "node",
          "okou",
          ...(command === updateCustomConnectorCommand ? [connector.id] : []),
          "--file",
          path,
        ]),
      ).rejects.toThrow("process.exit called");
      expect(error.mock.calls.flat().join("\n")).toContain(
        "Invalid JSON input",
      );
      expect(error.mock.calls.flat().join("\n")).not.toContain(SECRET);
    },
  );

  it.each([
    [createCustomConnectorCommand, "POST"],
    [updateCustomConnectorCommand, "PUT"],
  ] as const)(
    "definition writer suppresses reflected %s errors",
    async (command, method) => {
      const path = join(directory, "definition.json");
      writeFileSync(path, JSON.stringify(definition));
      server.use(
        http.all(
          `http://localhost:3000/api/custom-connectors${method === "PUT" ? `/${connector.id}` : ""}`,
          async ({ request }) => {
            expect(request.method).toBe(method);
            expect(await request.json()).toMatchObject({
              oauthConfig: { clientSecret: SECRET },
            });
            return HttpResponse.json(
              {
                error: { message: SECRET, code: SECRET },
                clientSecret: SECRET,
              },
              { status: 403 },
            );
          },
        ),
      );
      await expect(
        command.parseAsync([
          "node",
          "okou",
          ...(command === updateCustomConnectorCommand ? [connector.id] : []),
          "--file",
          path,
        ]),
      ).rejects.toThrow("process.exit called");
      expect(error.mock.calls.flat().join("\n")).toContain("HTTP 403");
      expect(error.mock.calls.flat().join("\n")).not.toContain(SECRET);
    },
  );
});
