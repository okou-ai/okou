import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import { http, HttpResponse } from "msw";
import { afterEach, test, vi } from "vitest";

import { testContext } from "../src/__tests__/test-context.ts";
import { server } from "../src/mocks/server.ts";
import { runDiscordCommandRegistration } from "./register-discord-commands.mjs";

const APPLICATION_ID = "123456789012345678";
const GUILD_ID = "234567890123456789";
const COMMAND_ID = "345678901234567890";
const BOT_TOKEN = "synthetic.bot.token";
const GUILD_URL = `https://discord.com/api/v10/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`;
const GLOBAL_URL = `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`;
const ENVIRONMENT = {
  DISCORD_APPLICATION_ID: APPLICATION_ID,
  DISCORD_BOT_TOKEN: BOT_TOKEN,
};
const SCRIPT_PATH = fileURLToPath(
  new URL("./register-discord-commands.mjs", import.meta.url),
);

testContext();
afterEach(() => {
  vi.restoreAllMocks();
});

function captureOutput() {
  const chunks = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return () => {
    return chunks.join("");
  };
}

function registeredCommand(guild = true) {
  return {
    id: COMMAND_ID,
    application_id: APPLICATION_ID,
    name: "okou",
    type: 1,
    ...(guild ? { guild_id: GUILD_ID } : {}),
  };
}

test("standalone help works without any server or Discord configuration", () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, "--help"], {
    env: {},
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /default: dry-run JSON/);
  assert.match(result.stdout, /Guild commands are unavailable in bot DMs/);
});

test("standalone guild preview needs no server configuration or token", () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--guild", GUILD_ID, "--application-id", APPLICATION_ID],
    { env: {}, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.mode, "dry-run");
  assert.equal(preview.url, GUILD_URL);
  assert.equal(preview.method, "POST");
  assert.equal(preview.command.name, "okou");
  assert.equal(preview.command.contexts, undefined);
  assert.equal(preview.command.integration_types, undefined);
  assert.deepEqual(
    preview.command.options.map((option) => {
      return option.name;
    }),
    ["help", "connect", "disconnect", "switch", "model", "org"],
  );
});

test("standalone invocation exits unsuccessfully when the scope is absent", () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, "--apply"], {
    env: {},
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Specify --guild <test-guild-id>/);
});

test("scope and snowflake validation prevent unintended destinations", async () => {
  for (const args of [
    [],
    ["--apply"],
    ["--guild", GUILD_ID, "--global"],
    ["--guild", "../../commands"],
    ["--guild", "18446744073709551616"],
    ["--guild", GUILD_ID, "--application-id", "not-an-id"],
    ["--guild", GUILD_ID, "--unknown"],
  ]) {
    await assert.rejects(runDiscordCommandRegistration(args, ENVIRONMENT));
  }
});

test("apply requires a token and rejects malformed tokens without echoing them", async () => {
  for (const token of [undefined, "", "secret\ninvalid-header"]) {
    await assert.rejects(
      runDiscordCommandRegistration(["--guild", GUILD_ID, "--apply"], {
        DISCORD_APPLICATION_ID: APPLICATION_ID,
        DISCORD_BOT_TOKEN: token,
      }),
      /^Error: Set DISCORD_BOT_TOKEN to a valid token without whitespace before using --apply\.$/,
    );
  }
});

test("guild apply upserts only /okou without overwriting other commands", async () => {
  const output = captureOutput();
  server.use(
    http.post(GUILD_URL, async ({ request }) => {
      assert.equal(request.headers.get("authorization"), `Bot ${BOT_TOKEN}`);
      const command = await request.json();
      assert.equal(command.name, "okou");
      assert.equal(command.type, 1);
      assert.equal(command.contexts, undefined);
      assert.equal(command.integration_types, undefined);
      return HttpResponse.json(registeredCommand(), { status: 201 });
    }),
  );

  await runDiscordCommandRegistration(
    ["--guild", GUILD_ID, "--apply"],
    ENVIRONMENT,
  );
  assert.match(output(), new RegExp(`Registered /okou \\(${COMMAND_ID}\\)`));
  assert.match(output(), new RegExp(`guild ${GUILD_ID}`));
  assert.ok(!output().includes(BOT_TOKEN));
});

test("global preview explicitly supports guild and bot DM contexts", async () => {
  const output = captureOutput();
  await runDiscordCommandRegistration(
    ["--global", "--application-id", APPLICATION_ID],
    {},
  );

  const preview = JSON.parse(output());
  assert.equal(preview.url, GLOBAL_URL);
  assert.deepEqual(preview.command.contexts, [0, 1]);
  assert.deepEqual(preview.command.integration_types, [0]);
});

test("global registration requires explicit global and apply flags", async () => {
  const output = captureOutput();
  server.use(
    http.post(GLOBAL_URL, async ({ request }) => {
      const command = await request.json();
      assert.deepEqual(command.contexts, [0, 1]);
      assert.deepEqual(command.integration_types, [0]);
      return HttpResponse.json(registeredCommand(false));
    }),
  );

  await runDiscordCommandRegistration(["--global", "--apply"], ENVIRONMENT);
  assert.match(output(), /global \(guilds and bot DMs\)/);
});

test("Discord rate limits return bounded retry guidance without reading the error body", async () => {
  server.use(
    http.post(GUILD_URL, () => {
      return HttpResponse.text(BOT_TOKEN, {
        status: 429,
        headers: { "Retry-After": "2.5" },
      });
    }),
  );

  await assert.rejects(
    runDiscordCommandRegistration(
      ["--guild", GUILD_ID, "--apply"],
      ENVIRONMENT,
    ),
    /^Error: Discord registration failed \(HTTP 429\)\. Discord rate limited registration\. Retry after 2\.5 seconds\.$/,
  );
});

test("Discord authorization errors expose no provider body or token", async () => {
  server.use(
    http.post(GUILD_URL, () => {
      return HttpResponse.text(BOT_TOKEN, { status: 401 });
    }),
  );

  await assert.rejects(
    runDiscordCommandRegistration(
      ["--guild", GUILD_ID, "--apply"],
      ENVIRONMENT,
    ),
    /^Error: Discord registration failed \(HTTP 401\)\. Check the application ID, bot token, and bot installation in the target guild\.$/,
  );
});

test("a mismatched registration receipt cannot be reported as success", async () => {
  const output = captureOutput();
  server.use(
    http.post(GUILD_URL, () => {
      return HttpResponse.json({
        ...registeredCommand(),
        guild_id: "456789012345678901",
      });
    }),
  );

  await assert.rejects(
    runDiscordCommandRegistration(
      ["--guild", GUILD_ID, "--apply"],
      ENVIRONMENT,
    ),
    /unexpected command registration/,
  );
  assert.equal(output(), "");
});
