import * as Sentry from "@sentry/node";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { http, HttpResponse } from "msw";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { z } from "zod";

import { server } from "../mocks/server";
import { configureGlobalProxyFromEnv } from "../lib/network/proxy";

const sentinels = {
  positional: "PRIVATE_POSITIONAL_33940",
  equals: "PRIVATE_EQUALS_33940",
  separate: "PRIVATE_SEPARATE_33940",
  trailing: "PRIVATE_AFTER_DASH_33940",
  console: "PRIVATE_CONSOLE_33940",
  message: "PRIVATE_EXCEPTION_33940",
  cause: "PRIVATE_CAUSE_33940",
  custom: "PRIVATE_CUSTOM_33940",
  system: "PRIVATE_SYSTEM_33940",
  path: "PRIVATE_PATH_33940",
  url: "PRIVATE_URL_33940",
  request: "PRIVATE_REQUEST_33940",
  context: "PRIVATE_CONTEXT_33940",
  child: "PRIVATE_CHILD_33940",
  trace: "33940abc33940abc33940abc33940abc",
  span: "33940abc33940abc",
  baggage: "PRIVATE_BAGGAGE_33940",
  attachment: "PRIVATE_ATTACHMENT_33940",
  user: "PRIVATE_USER_33940",
  fingerprint: "PRIVATE_FINGERPRINT_33940",
  tag: "PRIVATE_TAG_33940",
  sdk: "PRIVATE_SDK_33940",
  session: "PRIVATE_SESSION_33940",
  extraItem: "PRIVATE_ITEM_33940",
};
const argv = [
  "node",
  "okou",
  "chat",
  "send",
  sentinels.positional,
  `--text=${sentinels.equals}`,
  "--file",
  sentinels.separate,
  "--",
  sentinels.trailing,
];
const originalArgv = process.argv;
let okou: typeof import("../okou");
const envelopes: {
  body: string;
  url: string;
  headers: Record<string, string>;
}[] = [];
const eventSchema = z.object({
  event_id: z.string(),
  tags: z.record(z.string(), z.string()),
  exception: z.object({
    values: z.array(z.object({ type: z.string(), value: z.string() })),
  }),
  fingerprint: z.array(z.string()),
});

beforeAll(async () => {
  process.argv = argv;
  vi.stubEnv("SENTRY_DSN", "https://public@sentry.example/1");
  vi.stubEnv("SENTRY_ENVIRONMENT", "production");
  vi.stubEnv("SENTRY_TRACE", `${sentinels.trace}-${sentinels.span}-1`);
  vi.stubEnv(
    "SENTRY_BAGGAGE",
    `sentry-trace_id=${sentinels.trace},sentry-public_key=public,sentry-release=${sentinels.baggage},sentry-user_segment=${sentinels.user}`,
  );
  // Import the actual bootstrap, including the real SDK, after inherited input.
  await import("../instrument");
  process.argv = originalArgv;
  okou = await import("../okou");
});

beforeEach(() => {
  envelopes.length = 0;
  server.use(
    http.post("https://sentry.example/api/1/envelope/", async ({ request }) => {
      envelopes.push({
        body: await request.text(),
        url: request.url,
        headers: Object.fromEntries(request.headers),
      });
      return HttpResponse.json({});
    }),
  );
});

afterEach(async () => {
  await Sentry.flush(2000);
  Sentry.getCurrentScope().clear();
  Sentry.getIsolationScope().clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await Sentry.close();
  process.argv = originalArgv;
});

function events() {
  return envelopes.map(({ body }) => {
    const lines = body.split("\n");
    // Exactly one JSON event item: this checks the whole envelope, not just
    // the first event while overlooking attachments or another SDK item.
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]!)).toStrictEqual({ type: "event" });
    const event = eventSchema.parse(JSON.parse(lines[2]!));
    expect(JSON.parse(lines[0]!)).toStrictEqual({
      event_id: event.event_id,
      sent_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    return event;
  });
}

function observeCommands(prog: Command) {
  for (const command of prog.commands) {
    command.exitOverride().configureOutput(prog.configureOutput());
    observeCommands(command);
  }
}

function program() {
  return new Command("okou").exitOverride().configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
}

test("only allowlisted diagnostics cross the complete SDK network envelope", async () => {
  const terminal = vi.spyOn(console, "error").mockImplementation(() => {});
  server.use(
    http.get(`https://upstream.example/${sentinels.url}`, () => {
      return HttpResponse.json({});
    }),
  );
  const error = Object.assign(
    new TypeError(sentinels.message, { cause: new Error(sentinels.cause) }),
    {
      custom: sentinels.custom,
      code: sentinels.system,
      path: `/home/${sentinels.path}/file`,
      syscall: sentinels.system,
    },
  );
  const entry = fileURLToPath(new URL("../okou.ts", import.meta.url));
  error.stack = `TypeError: ${sentinels.message}\n    at ${sentinels.custom} (${entry}:42:7)\n    at ${sentinels.custom} (/home/${sentinels.path}/okou.js:12:3)`;
  const send = new Command("send")
    .argument("[text...]")
    .option("--text <value>")
    .option("--file <path>")
    .action(async () => {
      console.error(sentinels.console, { value: sentinels.console });
      await fetch(
        `https://upstream.example/${sentinels.url}?q=${sentinels.request}`,
      );
      expect(
        execFileSync(
          process.execPath,
          ["-e", "process.stdout.write(process.argv[1])", sentinels.child],
          { encoding: "utf8" },
        ),
      ).toBe(sentinels.child);
      throw error;
    });
  const prog = program();
  okou.registerCommands(prog, [new Command("chat").addCommand(send)]);
  observeCommands(prog);
  await expect(prog.parseAsync(argv)).rejects.toBe(error);
  expect(terminal).toHaveBeenCalledWith(sentinels.console, {
    value: sentinels.console,
  });
  expect(error.message).toBe(sentinels.message);
  expect(error.cause).toMatchObject({ message: sentinels.cause });

  Sentry.setUser({
    id: sentinels.user,
    email: `${sentinels.user}@example.com`,
  });
  Sentry.setContext("private", { value: sentinels.context });
  Sentry.setExtra("private", sentinels.custom);
  Sentry.setTag("cli.operation", sentinels.tag);
  Sentry.addBreadcrumb({
    message: sentinels.console,
    data: { path: sentinels.path },
  });
  Sentry.getCurrentScope().addAttachment({
    filename: sentinels.attachment,
    data: sentinels.attachment,
  });
  Sentry.captureException(error, {
    captureContext: { fingerprint: [sentinels.fingerprint] },
  });
  Sentry.captureException(new Error("not authenticated"));
  Sentry.captureMessage(sentinels.message);
  Sentry.logger.info(sentinels.console);
  Sentry.startSpan({ name: sentinels.trace, op: sentinels.baggage }, () => {});
  Sentry.startSession({ did: sentinels.session });
  Sentry.captureSession();
  // Direct SDK sends and additional item types do not go through beforeSend.
  await Sentry.getClient()!.sendEnvelope([
    {
      event_id: sentinels.trace,
      sent_at: sentinels.extraItem,
      trace: { trace_id: sentinels.trace, public_key: sentinels.baggage },
    },
    [[{ type: "event" }, { message: sentinels.extraItem }]],
  ]);
  await expect(Sentry.flush(2000)).resolves.toBe(true);

  expect(events()).toHaveLength(1);
  const body = JSON.parse(envelopes[0]!.body.split("\n")[2]!);
  expect(body).toStrictEqual({
    event_id: expect.stringMatching(/^[a-f0-9]{32}$/),
    timestamp: expect.any(Number),
    platform: "node",
    level: "error",
    release: "0.0.0-test",
    environment: "production",
    tags: { app: "cli", "cli.phase": "command", "cli.operation": "chat send" },
    contexts: { runtime: { name: "node", version: process.versions.node } },
    exception: {
      values: [
        {
          type: "TypeError",
          value: "TypeError",
          stacktrace: {
            frames: [
              { filename: "okou.js", in_app: true, lineno: 42, colno: 7 },
            ],
          },
        },
      ],
    },
    fingerprint: ["{{ default }}", "chat send"],
  });
  for (const sentinel of Object.values(sentinels)) {
    expect(JSON.stringify(envelopes)).not.toContain(sentinel);
  }
});

test("ignores arbitrary SDK event fields and modifications after beforeSend", async () => {
  const client = Sentry.getClient()!;
  const remove = client.on("beforeSendEvent", (event) => {
    event.extra = { private: sentinels.custom };
    event.sdk = { name: sentinels.sdk, version: sentinels.sdk };
  });
  try {
    Sentry.captureEvent({
      event_id: sentinels.trace,
      timestamp: 33940,
      environment: sentinels.context,
      release: sentinels.context,
      server_name: sentinels.path,
      message: sentinels.message,
      logentry: { message: sentinels.message },
      request: {
        url: sentinels.url,
        headers: { private: sentinels.request },
        data: sentinels.request,
        query_string: sentinels.request,
      },
      contexts: { private: { private: sentinels.context } },
      extra: { private: sentinels.custom },
      tags: { "cli.operation": sentinels.tag },
      fingerprint: [sentinels.fingerprint],
      exception: {
        values: [
          {
            type: sentinels.custom,
            value: sentinels.message,
            stacktrace: {
              frames: [
                {
                  filename: `/home/${sentinels.path}/okou.js`,
                  function: sentinels.custom,
                  vars: { private: sentinels.context },
                  context_line: sentinels.context,
                },
              ],
            },
          },
        ],
      },
    });
    await expect(Sentry.flush(2000)).resolves.toBe(true);
  } finally {
    remove();
  }
  expect(events()).toMatchObject([
    {
      tags: { app: "cli", "cli.phase": "startup" },
      exception: { values: [{ type: "Error", value: "Error" }] },
    },
  ]);
  for (const sentinel of Object.values(sentinels))
    expect(JSON.stringify(envelopes)).not.toContain(sentinel);
});

test("uses canonical registered parent names for aliases on both parser entry points", async () => {
  const prog = program();
  const list = new Command("list").alias("ls").action(() => {
    throw new RangeError(sentinels.message);
  });
  okou.registerCommands(prog, [new Command("model").addCommand(list)]);
  observeCommands(prog);
  for (const parse of [
    () => {
      return prog.parse(["model", "ls"], { from: "user" });
    },
    () => {
      return prog.parseAsync(["model", "list"], { from: "user" });
    },
  ]) {
    try {
      await parse();
    } catch (error) {
      Sentry.captureException(error);
    }
  }
  await Sentry.flush(2000);
  expect(events()).toHaveLength(2);
  for (const event of events()) {
    expect(event.tags).toStrictEqual({
      app: "cli",
      "cli.phase": "command",
      "cli.operation": "model list",
    });
    expect(event.fingerprint).toStrictEqual(["{{ default }}", "model list"]);
  }
});

test("help, unknown input, parser failures and startup never reuse an earlier operation", async () => {
  const prog = program();
  okou.registerCommands(prog, [
    new Command("send")
      .option("--value <value>", "value", () => {
        throw new SyntaxError(sentinels.separate);
      })
      .action(() => {
        Sentry.captureException(new Error(sentinels.message));
      }),
  ]);
  observeCommands(prog);
  await prog.parseAsync(["send"], { from: "user" });
  for (const args of [
    ["--help"],
    [sentinels.positional],
    ["send", `--${sentinels.equals}=value`],
    ["send", "--value", sentinels.separate],
  ]) {
    try {
      await prog.parseAsync(args, { from: "user" });
    } catch (error) {
      Sentry.captureException(error);
    }
  }
  Sentry.captureException(new Error(sentinels.cause));
  await Sentry.flush(2000);
  expect(
    events().map((event) => {
      return event.tags;
    }),
  ).toStrictEqual([
    { app: "cli", "cli.phase": "command", "cli.operation": "send" },
    ...Array.from({ length: 4 }, () => {
      return { app: "cli", "cli.phase": "parse" };
    }),
    { app: "cli", "cli.phase": "startup" },
  ]);
  for (const sentinel of Object.values(sentinels))
    expect(JSON.stringify(envelopes)).not.toContain(sentinel);
});

test("real lazy registration preserves help and excludes early proxy failure content", async () => {
  const prog = program();
  const args = ["node", "okou", "model", "ls", "--help"];
  let help = "";
  prog.configureOutput({
    writeOut: (text) => {
      help += text;
    },
  });
  await okou.registerRequestedCommand(prog, args);
  observeCommands(prog);
  await expect(prog.parseAsync(args)).rejects.toMatchObject({
    code: "commander.helpDisplayed",
  });
  expect(help).toContain("Usage: okou model list");
  vi.stubEnv("http_proxy", "");
  vi.stubEnv("https_proxy", "");
  vi.stubEnv("HTTP_PROXY", "");
  vi.stubEnv("HTTPS_PROXY", sentinels.url);
  const proxyError = await configureGlobalProxyFromEnv().catch(
    (error: unknown) => {
      return error;
    },
  );
  expect(proxyError).toMatchObject({
    message:
      "Invalid proxy configuration. Check HTTP_PROXY/HTTPS_PROXY/NO_PROXY values.",
  });
  Sentry.captureException(proxyError);
  await Sentry.flush(2000);
  expect(envelopes).toStrictEqual([]);
});
