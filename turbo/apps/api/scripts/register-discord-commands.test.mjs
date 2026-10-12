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
const COMMAND_NAMES = ["help", "connect", "disconnect", "switch", "model"];
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

function registeredCommand(name, guild = true, id = COMMAND_ID) {
  return {
    id,
    application_id: APPLICATION_ID,
    name,
    type: 1,
    ...(guild ? { guild_id: GUILD_ID } : {}),
  };
}

function mockRegistration({ guild = true, commands = [], failName } = {}) {
  const url = guild ? GUILD_URL : GLOBAL_URL;
  const installed = new Map(
    commands.map((command) => {
      return [command.id, command];
    }),
  );
  let nextId = BigInt(COMMAND_ID);
  server.use(
    http.get(url, () => {
      return HttpResponse.json([...installed.values()]);
    }),
    http.post(url, async ({ request }) => {
      assert.equal(request.headers.get("authorization"), `Bot ${BOT_TOKEN}`);
      const command = await request.json();
      assert.equal(command.type, 1);
      if (guild) {
        assert.equal(command.contexts, undefined);
        assert.equal(command.integration_types, undefined);
      } else {
        assert.deepEqual(command.contexts, [0, 1]);
        assert.deepEqual(command.integration_types, [0]);
      }
      if (command.name === failName) {
        return HttpResponse.text(BOT_TOKEN, {
          status: 429,
          headers: { "Retry-After": "2.5" },
        });
      }
      const existing = [...installed.values()].find((entry) => {
        return entry.name === command.name && entry.type === command.type;
      });
      const id = existing?.id ?? String(++nextId);
      const saved = {
        ...command,
        ...registeredCommand(command.name, guild, id),
      };
      installed.set(id, saved);
      return HttpResponse.json(saved, { status: 201 });
    }),
    http.delete(`${url}/:commandId`, ({ request, params }) => {
      assert.equal(request.headers.get("authorization"), `Bot ${BOT_TOKEN}`);
      return installed.delete(String(params.commandId))
        ? new HttpResponse(null, { status: 204 })
        : HttpResponse.json({ code: 10_063 }, { status: 404 });
    }),
  );
  return async () => {
    return (await globalThis.fetch(url)).json();
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
  assert.deepEqual(
    preview.commands.map((command) => {
      return command.name;
    }),
    COMMAND_NAMES,
  );
  for (const command of preview.commands) {
    assert.equal(command.contexts, undefined);
    assert.equal(command.integration_types, undefined);
  }
  assert.deepEqual(preview.removeCommands, [{ name: "okou", type: 1 }]);
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

test("guild registration replaces the grouped command and preserves unrelated commands", async () => {
  const output = captureOutput();
  const unrelated = [
    registeredCommand("status", true, "456789012345678901"),
    { ...registeredCommand("okou", true, "567890123456789012"), type: 2 },
  ];
  const readCommands = mockRegistration({
    commands: [registeredCommand("okou"), ...unrelated],
  });
  const args = ["--guild", GUILD_ID, "--apply"];

  await runDiscordCommandRegistration(args, ENVIRONMENT);
  const registered = await readCommands();
  assert.deepEqual(
    registered
      .filter((entry) => {
        return !unrelated.some((other) => {
          return other.id === entry.id;
        });
      })
      .map((entry) => {
        return entry.name;
      }),
    COMMAND_NAMES,
  );
  for (const command of unrelated) {
    assert.deepEqual(
      registered.find((entry) => {
        return entry.id === command.id;
      }),
      command,
    );
  }
  assert.equal(registered.length, COMMAND_NAMES.length + unrelated.length);
  assert.match(output(), /Removed \/okou/);
  assert.match(output(), /Verify \/help/);
  assert.ok(!output().includes(BOT_TOKEN));

  await runDiscordCommandRegistration(args, ENVIRONMENT);
  assert.deepEqual(await readCommands(), registered);
});

test("global preview explicitly supports guild and bot DM contexts", async () => {
  const output = captureOutput();
  await runDiscordCommandRegistration(
    ["--global", "--application-id", APPLICATION_ID],
    {},
  );

  const preview = JSON.parse(output());
  assert.equal(preview.url, GLOBAL_URL);
  for (const command of preview.commands) {
    assert.deepEqual(command.contexts, [0, 1]);
    assert.deepEqual(command.integration_types, [0]);
  }
});

test("global registration leaves commands in other scopes unchanged", async () => {
  const output = captureOutput();
  const guildCommand = registeredCommand("okou");
  const readGuild = mockRegistration({ commands: [guildCommand] });
  const readGlobal = mockRegistration({
    guild: false,
    commands: [registeredCommand("okou", false)],
  });

  await runDiscordCommandRegistration(["--global", "--apply"], ENVIRONMENT);
  assert.deepEqual(
    (await readGlobal()).map((command) => {
      return command.name;
    }),
    COMMAND_NAMES,
  );
  assert.deepEqual(await readGuild(), [guildCommand]);
  assert.match(output(), /global \(guilds and bot DMs\)/);
});

test("a partial registration preserves the grouped command until every replacement succeeds", async () => {
  const output = captureOutput();
  const previous = registeredCommand("okou");
  const readCommands = mockRegistration({
    commands: [previous],
    failName: "disconnect",
  });

  await assert.rejects(
    runDiscordCommandRegistration(
      ["--guild", GUILD_ID, "--apply"],
      ENVIRONMENT,
    ),
    /^Error: Discord registration failed \(HTTP 429\)\. Discord rate limited registration\. Retry after 2\.5 seconds\.$/,
  );
  const registered = await readCommands();
  assert.deepEqual(
    registered.find((entry) => {
      return entry.id === previous.id;
    }),
    previous,
  );
  assert.deepEqual(
    registered.map((entry) => {
      return entry.name;
    }),
    ["okou", "help", "connect"],
  );
  assert.match(output(), /Registered \/help/);
  assert.match(output(), /Registered \/connect/);
  assert.ok(!output().includes(BOT_TOKEN));
});

test("Discord authorization errors expose no provider body or token", async () => {
  server.use(
    http.get(GUILD_URL, () => {
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
  const previous = registeredCommand("okou");
  const readCommands = mockRegistration({ commands: [previous] });
  server.use(
    http.post(GUILD_URL, () => {
      return HttpResponse.json({
        ...registeredCommand("help"),
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
  assert.deepEqual(await readCommands(), [previous]);
});

test("a command list with an unexpected scope cannot authorize cleanup", async () => {
  const output = captureOutput();
  server.use(
    http.get(GUILD_URL, () => {
      return HttpResponse.json([registeredCommand("okou", false)]);
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
