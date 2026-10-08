import { Command } from "commander";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { registerRequestedCommand } from "../../../okou";
import { connectCommand } from "../connect";

const endpoint = "http://localhost:3000/api/integrations/discord/oauth/start";
const authorizationUrl =
  "https://discord.com/oauth2/authorize?client_id=123456789012345678&state=opaque-one-use-state&scope=identify";

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
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    for (const option of ["install", "guildId", "json"]) {
      connectCommand.setOptionValue(option, undefined);
    }
  });

  it("starts authenticated member consent and prints the exact URL without reporting a connection", async () => {
    let body: unknown;
    let authorization: string | null = null;
    let query: string | undefined;
    server.use(
      http.post(endpoint, async ({ request }) => {
        body = await request.json();
        authorization = request.headers.get("Authorization");
        query = new URL(request.url).search;
        return HttpResponse.json({ authorizationUrl });
      }),
    );
    await run();
    expect(body).toStrictEqual({ flow: "connect" });
    expect(authorization).toBe("Bearer test-token");
    expect(query).toBe("");
    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain(authorizationUrl);
    expect(text).toContain("complete official Discord browser consent");
    expect(text).toContain("Authorization has not completed");
  });

  it("starts an admin install with an exact large snowflake and exposes the URL in JSON", async () => {
    const guildId = "18446744073709551615";
    let body: unknown;
    server.use(
      http.post(endpoint, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ authorizationUrl });
      }),
    );
    await run(["--install", "--guild-id", guildId, "--json"]);
    expect(body).toStrictEqual({ flow: "install", guildId });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      authorizationUrl,
    });
  });

  it.each(["0", "1e18", "18446744073709551616"])(
    "rejects invalid guild ID %s before authorization",
    async (guildId) => {
      await expect(run(["--guild-id", guildId])).rejects.toThrow(
        "process.exit",
      );
      expect(errors.mock.calls.flat().join("\n")).toContain("snowflake ID");
      expect(output).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: 403, message: "Organization admin required" },
    { status: 503, message: "Discord OAuth is not configured" },
  ])(
    "surfaces $status and does not print a consent URL",
    async ({ status, message }) => {
      server.use(
        http.post(endpoint, () => {
          return HttpResponse.json(
            { error: { code: "FORBIDDEN", message } },
            { status },
          );
        }),
      );
      await expect(run(["--install"])).rejects.toThrow("process.exit");
      expect(errors.mock.calls.flat().join("\n")).toContain(message);
      expect(output).not.toHaveBeenCalled();
    },
  );

  it("guides an unauthenticated caller to OKOU_TOKEN setup", async () => {
    vi.stubEnv("OKOU_TOKEN", "");
    await expect(run()).rejects.toThrow("process.exit");
    expect(errors.mock.calls.flat().join("\n")).toContain("Set OKOU_TOKEN");
    expect(output).not.toHaveBeenCalled();
  });
});
