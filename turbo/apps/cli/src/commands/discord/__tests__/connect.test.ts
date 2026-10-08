import { Command } from "commander";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { registerRequestedCommand } from "../../../okou";
import { connectCommand } from "../connect";

async function run(args: string[] = []) {
  const argv = ["node", "okou", "discord", "connect", ...args];
  const program = new Command();
  await registerRequestedCommand(program, argv);
  await program.parseAsync(argv);
}

describe("okou discord connect", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit");
  });

  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "private-run-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
    for (const option of ["install", "guildId", "json"]) {
      connectCommand.setOptionValue(option, undefined);
    }
  });

  it("hands off to independently authenticated App Works without creating a browser-correlated attempt in the CLI", async () => {
    const attempts: unknown[] = [];
    server.use(
      http.post(
        "*/api/integrations/discord/oauth/start",
        async ({ request }) => {
          attempts.push(await request.json());
          return HttpResponse.json({
            authorizationUrl:
              "https://discord.com/oauth2/authorize?state=unusable-cli-attempt",
          });
        },
      ),
    );
    await run();
    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain("https://app.okou.ai/works");
    expect(text).toContain("sign in, and select the intended organization");
    expect(text).toContain("Choose Connect");
    expect(text).toContain("Complete official Discord browser consent");
    expect(text).toContain(
      "Authorization has not started or completed in this CLI",
    );
    expect(text).not.toContain("private-run-token");
    expect(text).not.toContain("discord.com/oauth2");
    expect(attempts).toStrictEqual([]);
  });

  it("returns configured App origin with install and exact guild guidance, without owner or credential query parameters", async () => {
    const guildId = "18446744073709551615";
    vi.stubEnv(
      "OKOU_APP_URL",
      "https://app.custom.test/ignored?state=do-not-transfer",
    );
    await run(["--install", "--guild-id", guildId, "--json"]);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      url: "https://app.custom.test/works",
      flow: "install",
      guildId,
    });
  });

  it.each([
    { api: "https://api.okou.ai", app: "https://app.okou.ai" },
    { api: "https://staging-api.vm6.ai", app: "https://staging-app.omby.ai" },
    { api: "https://pr-123-api.vm6.ai", app: "https://pr-123-app.omby.ai" },
  ])("reuses canonical API-to-App mapping for $api", async ({ api, app }) => {
    vi.stubEnv("OKOU_APP_URL", "");
    vi.stubEnv("OKOU_API_BACKEND_URL", api);
    await run(["--json"]);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      url: `${app}/works`,
      flow: "connect",
    });
  });

  it("guides an admin to actual installation without claiming any binding", async () => {
    await run(["--install", "--guild-id", "123456789012345678"]);
    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain(
      "Choose Install to Discord as an organization admin",
    );
    expect(text).toContain(
      "Select Discord server 123456789012345678 during consent",
    );
    expect(text).toContain("guidance, not a verified binding");
  });

  it.each(["", "0", "1e18", "18446744073709551616"])(
    "rejects invalid guild ID %s rather than pretending it selected a server",
    async (guildId) => {
      await expect(run(["--guild-id", guildId])).rejects.toThrow(
        "process.exit",
      );
      expect(errors.mock.calls.flat().join("\n")).toContain("snowflake ID");
      expect(output).not.toHaveBeenCalled();
    },
  );
});
