import { Command } from "commander";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { registerRequestedCommand } from "../../../okou";

describe("retired built-in media generation", () => {
  let output: string;
  let requests: string[];

  beforeEach(() => {
    output = "";
    requests = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output += args.join(" ");
    });
    server.use(
      http.all("*", ({ request }) => {
        requests.push(`${request.method} ${request.url}`);
        return HttpResponse.json(
          { error: "Unexpected request" },
          { status: 500 },
        );
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function run(args: string[]): Promise<void> {
    const argv = ["node", "okou", "generate", ...args];
    const program = new Command("okou");
    await registerRequestedCommand(program, argv);
    function reset(command: Command): void {
      command.exitOverride().configureOutput({
        writeOut: (text) => {
          output += text;
        },
        writeErr: () => {},
      });
      for (const option of command.options) {
        command.setOptionValue(option.attributeName(), option.defaultValue);
      }
      command.commands.forEach(reset);
    }
    reset(program);
    await program.parseAsync(argv);
  }

  it.each(["video", "voice", "avatar-video"])(
    "explains that built-in %s is unavailable without making a request",
    async (type) => {
      await run([type, "--provider", "built-in"]);

      expect(output).toContain(
        `Okou has no built-in ${type} generation pipeline.`,
      );
      expect(output).toContain("connector-backed provider");
      expect(requests).toEqual([]);
    },
  );
});
