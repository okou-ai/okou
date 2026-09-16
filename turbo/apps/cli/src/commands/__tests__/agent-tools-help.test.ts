import type { Command, OutputConfiguration } from "commander";
import { afterEach, afterAll, describe, expect, it, vi } from "vitest";

import { chatCommand } from "../chat";
import { connectorCommand } from "../connector";
import { generateCommand } from "../generate";
import { hostCommand } from "../host";
import { mailCommand } from "../mail";
import { presentationCommand as presentationRenderCommand } from "../presentation";
import { presentationTemplateCommand } from "../presentation-template";
import { resourceCommand } from "../resource";
import { socialCommand } from "../social";
import { sshCommand } from "../ssh";
import { webCommand } from "../web";
import { workflowCommand } from "../workflow";

const exit = vi.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("CLI exit");
}) as never);

function nestedCommand(root: Command, path: readonly string[]): Command {
  return path.reduce((parent, name) => {
    const child = parent.commands.find((command) => {
      return command.name() === name || command.aliases().includes(name);
    });
    if (!child) {
      throw new Error(`Missing command ${[root.name(), ...path].join(" ")}`);
    }
    return child;
  }, root);
}

async function helpFor(
  root: Command,
  path: readonly string[] = [],
): Promise<string> {
  const target = nestedCommand(root, path);
  const previous: OutputConfiguration = target.configureOutput();
  let output = "";
  target.configureOutput({
    ...previous,
    writeOut: (text) => {
      output += text;
    },
  });
  try {
    await expect(
      root.parseAsync([...path, "--help"], { from: "user" }),
    ).rejects.toThrow("CLI exit");
  } finally {
    target.configureOutput(previous);
  }
  return output.replace(/\s+/gu, " ").trim();
}

afterEach(() => {
  process.exitCode = 0;
  exit.mockClear();
});

afterAll(() => {
  exit.mockRestore();
});

describe("agent-facing operational CLI help", () => {
  it("routes SSH work through current inventory and exposes uncertainty and resource limits", async () => {
    const root = await helpFor(sshCommand);
    expect(root).toContain("okou ssh host list --json");
    expect(root).toContain("least-privilege remote SSH user");
    expect(root).toContain("unexpected key requires owner verification");
    expect(root).toContain("effects=unknown");
    expect(root).toContain("execution authority is cached for this Run");

    const read = await helpFor(sshCommand, ["session", "read"]);
    expect(read).toContain("Only 2 reads per Run");
    expect(read).toContain("Exit 0 means the read succeeded");
    expect(read).toContain("Follow next_command and next_cursor");
    expect(read).toContain("exact base64 chunks");

    const upload = await helpFor(sshCommand, ["upload"]);
    expect(upload).toContain("1 GiB (1,073,741,824 bytes)");
    expect(upload).toContain("shared by uploads and downloads");
    expect(upload).toContain("streamed-byte SHA-256");
    expect(upload).toContain("inspect the destination first");
  });

  it("documents Social discovery, export recovery, and durable download receipts", async () => {
    const root = await helpFor(socialCommand);
    expect(root).toContain("capabilities is offline");
    expect(root).toContain("--limit applies to the total returned result");
    expect(root).toContain("metadata-only kind=summary record");
    expect(root).toContain(
      "Prefer Okou Social for supported public X research",
    );

    const search = await helpFor(socialCommand, ["search"]);
    expect(search).toContain("Existing files require explicit --overwrite");
    expect(search).toContain("without repeating the billed Social request");
    expect(search).toContain("okou web upload-file");

    const transcript = await helpFor(socialCommand, ["transcript"]);
    expect(transcript).toContain("Missing timing is never inferred");
    expect(transcript).toContain("recovered stdout JSON");

    const download = await helpFor(socialCommand, ["download"]);
    expect(download).toContain("audio pricing");
    expect(download).toContain("delivered format and artifact MIME");
    expect(download).toContain(
      "does not cancel upstream work or prevent billing",
    );

    const downloads = await helpFor(socialCommand, ["downloads"]);
    expect(downloads).toContain("without starting, polling, or billing");
    expect(downloads).toContain(
      "verify that its task and original target match",
    );
  });

  it("keeps connector account and permission recovery on exact diagnosed values", async () => {
    const root = await helpFor(connectorCommand);
    expect(root).toContain("exact returned connectionId");
    expect(root).toContain("Diagnose the exact failed URL and method");
    expect(root).toContain(
      "Provider OAuth scope names are not Okou permissions",
    );
    expect(root).toContain("exactly one access action");

    const accounts = await helpFor(connectorCommand, ["account", "list"]);
    expect(accounts).toContain("never invent an ID");
    expect(accounts).toContain("account already admitted to the current Run");

    const check = await helpFor(connectorCommand, ["check"]);
    expect(check).toContain("omit query strings and fragments");
    expect(check).toContain("okou whoami --permissions");
    expect(check).toContain("missing_scope or needed");

    const request = await helpFor(connectorCommand, ["permission-request"]);
    expect(request).toContain("one command per permission");
    expect(request).toContain("do not use callbacks");
    expect(request).toContain("verbatim with all query parameters");
  });

  it("explains independent chat runs and durable workflow automation", async () => {
    const create = await helpFor(chatCommand, ["create"]);
    expect(create).toContain("does not start a run");
    expect(create).toContain("first message must be self-contained");

    const send = await helpFor(chatCommand, ["send"]);
    expect(send).toContain("does not wait for completion");
    expect(send).toContain("independent lifetime");

    const messages = await helpFor(chatCommand, ["messages"]);
    expect(messages).toContain("point-in-time read/sync");
    expect(messages).toContain("not one run ID");
    expect(messages).toContain("workflow's automation thread");

    const workflow = await helpFor(workflowCommand);
    expect(workflow).toContain("persist a durable workflow through the API");
    expect(workflow).toContain("--dir uploads supplementary files only");
    expect(workflow).toContain("will not persist or sync back");
    expect(workflow).toContain("ScheduleWakeup");

    const automation = await helpFor(workflowCommand, ["automation"]);
    expect(automation).toContain("case-insensitive * wildcard");
    expect(automation).toContain("rather than resuming the watched run");
    expect(automation).toContain("until disabled or removed");
  });

  it("routes generation, artifact delivery, template preparation, and mail review", async () => {
    const generate = await helpFor(generateCommand);
    expect(generate).toContain("attached generation template");
    expect(generate).toContain("avatar-video uses --script or --audio-url");
    expect(generate).toContain(
      "wait for it to finish and use the returned artifact",
    );

    const upload = await helpFor(webCommand, ["upload-file"]);
    expect(upload).toContain("does not publish a static site");
    expect(upload).toContain("Avoid duplicate delivery");

    const host = await helpFor(hostCommand);
    expect(host).toContain("does not deploy a long-running backend");
    expect(host).toContain("--artifact-kind presentation-html");
    expect(host).toContain("user-facing artifact view");

    const pull = await helpFor(resourceCommand, ["pull"]);
    expect(pull).toContain("skill:presentation-reverse-template");
    expect(pull).toContain("exact 40-hex commit");
    expect(pull).toContain("reverse-template/SKILL.md");

    const screenshot = await helpFor(presentationRenderCommand, ["screenshot"]);
    expect(screenshot).toContain("uploads and publishes nothing");
    expect(screenshot).toContain(
      "independent of okou presentation-template publish",
    );

    const publish = await helpFor(presentationTemplateCommand, ["publish"]);
    expect(publish).toContain("publish step, not page rendering");
    expect(publish).toContain("okou presentation screenshot");

    const mail = await helpFor(mailCommand, ["link"]);
    expect(mail).toContain("does not create, update, or send email");
    expect(mail).toContain("do not add a mail callback prompt");
    expect(mail).toContain("verify the Gmail thread has the SENT label");
  });
});
