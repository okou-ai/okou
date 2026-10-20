import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { stubConnectedConnectors } from "../../__tests__/helpers/connector-accounts";
import {
  catalogItem,
  manualAuthMethod,
  stubConnectorCatalog,
} from "../../__tests__/helpers/connector-catalog";
import { generateCommand } from "../index";

const metadata = catalogItem({
  connectorSlug: "fal",
  label: "fal.ai",
  generation: ["image"],
  authMethods: [manualAuthMethod()],
});

describe("generation current-member directory", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("command exited");
  });

  function output(): string {
    return log.mock.calls.flat().join("\n");
  }

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_AGENT_ID", "");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", "");
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", "");
    server.use(stubConnectorCatalog([metadata]));
  });

  afterEach(() => {
    log.mockClear();
    error.mockClear();
    exit.mockClear();
    vi.unstubAllEnvs();
  });

  it("discovers matching saved providers when account details are unavailable without claiming readiness", async () => {
    server.use(
      stubConnectorCatalog([
        metadata,
        catalogItem({
          connectorSlug: "openai",
          label: "OpenAI",
          generation: ["text"],
        }),
      ]),
      stubConnectedConnectors(["fal", "openai"]),
      http.get(
        "http://localhost:3000/api/connector-accounts/connections",
        () => {
          return HttpResponse.json(
            {
              error: {
                code: "UNAVAILABLE",
                message: "Account details unavailable",
              },
            },
            { status: 503 },
          );
        },
      ),
    );

    await generateCommand.parseAsync(["node", "okou", "image", "--all"]);

    expect(output()).toContain("fal.ai");
    expect(output()).toContain(
      "saved accounts; inspect with okou connector status fal",
    );
    expect(output()).toContain(
      "Saved accounts may need setup, reconnect, or permission updates.",
    );
    expect(output()).toContain(
      "directory membership does not establish runtime availability or agent authorization",
    );
    expect(output()).not.toMatch(/^ {2}openai\s/mu);
    expect(error).not.toHaveBeenCalled();
  });

  it("offers a connection when a matching provider has no saved account", async () => {
    server.use(stubConnectedConnectors([]));

    await generateCommand.parseAsync(["node", "okou", "image", "--all"]);

    expect(output()).toContain(
      "No image generation connectors with saved accounts found.",
    );
    expect(output()).toContain("no saved accounts");
    expect(output()).toContain(
      "[Connect fal.ai](http://localhost:3000/connectors/fal/connect)",
    );
  });

  it("fails visibly when the saved-account directory cannot be read", async () => {
    server.use(
      http.get("http://localhost:3000/api/connectors/connected", () => {
        return HttpResponse.json(
          {
            error: {
              code: "UNAVAILABLE",
              message: "Saved-account directory unavailable",
            },
          },
          { status: 503 },
        );
      }),
    );

    await expect(
      generateCommand.parseAsync(["node", "okou", "image", "--all"]),
    ).rejects.toThrow("command exited");

    expect(error.mock.calls.flat().join("\n")).toContain(
      "Saved-account directory unavailable",
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).not.toHaveBeenCalled();
  });

  it.each(["image", "presentation"])(
    "shows the built-in %s command without a directory dependency when there are no connector candidates",
    async (type) => {
      server.use(
        stubConnectorCatalog([]),
        http.get("http://localhost:3000/api/connectors/connected", () => {
          return HttpResponse.json(
            {
              error: {
                code: "UNAVAILABLE",
                message: "Saved-account directory unavailable",
              },
            },
            { status: 503 },
          );
        }),
      );

      await generateCommand.parseAsync(["node", "okou", type]);

      expect(output()).toContain("Built-in command:");
      expect(error).not.toHaveBeenCalled();
    },
  );
});
