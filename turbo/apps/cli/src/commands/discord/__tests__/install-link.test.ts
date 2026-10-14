import { Command } from "commander";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { registerRequestedCommand } from "../../../okou";
import { installLinkCommand } from "../install-link";

async function run(args: string[] = []) {
  const argv = ["node", "okou", "discord", "install-link", ...args];
  const program = new Command();
  await registerRequestedCommand(program, argv);
  await program.parseAsync(argv);
}

describe("okou discord install-link", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit");
  });
  const invite = "https://discord.gg/example";
  const result = {
    url: "https://preview-app.example/settings/discord/install?guild_id=123456789012345678",
    guildId: "123456789012345678",
    guildName: "New server",
  };

  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "private-run-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    for (const option of ["invite", "json"]) {
      installLinkCommand.setOptionValue(option, undefined);
    }
  });

  it.each([false, true])(
    "returns the exact installation link without starting OAuth (json: %s)",
    async (json) => {
      const requests: unknown[] = [];
      server.use(
        http.post(
          "*/api/integrations/discord/install-link",
          async ({ request }) => {
            requests.push(await request.json());
            expect(request.headers.get("authorization")).toBe(
              "Bearer private-run-token",
            );
            return HttpResponse.json(result);
          },
        ),
      );
      await run(["--invite", invite, ...(json ? ["--json"] : [])]);
      expect(requests).toStrictEqual([{ invite }]);
      if (json) {
        expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual(
          result,
        );
      } else {
        expect(output.mock.calls.flat()).toContain(result.url);
        expect(output.mock.calls.flat().join("\n")).toContain(
          "Generating this link does not add Okou to the server",
        );
      }
      expect(output.mock.calls.flat().join("\n")).not.toContain(
        "private-run-token",
      );
    },
  );

  it("reports invalid invitations without printing a fabricated link", async () => {
    server.use(
      http.post("*/api/integrations/discord/install-link", () => {
        return HttpResponse.json(
          {
            error: {
              code: "NOT_FOUND",
              message:
                "The invitation has expired. Ask for a new server invite.",
            },
          },
          { status: 404 },
        );
      }),
    );
    await expect(run(["--invite", invite, "--json"])).rejects.toThrow(
      "process.exit",
    );
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "invitation has expired",
    );
    expect(output).not.toHaveBeenCalled();
  });
});
