import { randomUUID } from "node:crypto";
import process from "node:process";
import { HttpResponse, http } from "msw";
import { expect, onTestFinished, test, vi } from "vitest";

import { server } from "../src/mocks/server.ts";
import { runDiscordCommandRegistration } from "./register-discord-commands.mjs";

const APPLICATION_ID = "123456789012345678";
const GUILD_ID = "223456789012345678";
const DISCORD_API = "https://discord.com/api/v10";
const GUILD_URL = `${DISCORD_API}/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`;
const GLOBAL_URL = `${DISCORD_API}/applications/${APPLICATION_ID}/commands`;

function captureStdout() {
  const chunks = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  onTestFinished(() => {
    spy.mockRestore();
  });
  return () => {
    return chunks.join("");
  };
}

/**
 * In-memory Discord application command store with one list per scope.
 */
function discordCommands({ global = [], guild = [], rejectPost } = {}) {
  let nextId = 400_000_000_000_000_000n;
  const scopes = { global: [...global], guild: [...guild] };
  const authorizations = [];

  function scopeOf(params) {
    return params.guildId === undefined ? "global" : "guild";
  }

  function list(params) {
    return {
      ok:
        params.appId === APPLICATION_ID &&
        (params.guildId === undefined || params.guildId === GUILD_ID),
      commands: scopes[scopeOf(params)],
    };
  }

  function upsert(params, body) {
    const scope = scopeOf(params);
    const existing = scopes[scope].find((command) => {
      return command.name === body.name && command.type === body.type;
    });
    const stored = {
      ...body,
      id: existing ? existing.id : String(nextId++),
      application_id: APPLICATION_ID,
      ...(scope === "guild" ? { guild_id: GUILD_ID } : {}),
    };
    scopes[scope] = existing
      ? scopes[scope].map((command) => {
          return command.id === existing.id ? stored : command;
        })
      : [...scopes[scope], stored];
    return stored;
  }

  const collectionHandlers = [
    `${DISCORD_API}/applications/:appId/guilds/:guildId/commands`,
    `${DISCORD_API}/applications/:appId/commands`,
  ].flatMap((path) => {
    return [
      http.get(path, ({ request, params }) => {
        authorizations.push(request.headers.get("authorization"));
        const { ok, commands } = list(params);
        return ok
          ? HttpResponse.json(commands)
          : HttpResponse.json({}, { status: 404 });
      }),
      http.post(path, async ({ request, params }) => {
        authorizations.push(request.headers.get("authorization"));
        const body = await request.json();
        const rejection = rejectPost?.(body);
        if (rejection) {
          return rejection;
        }
        return HttpResponse.json(upsert(params, body));
      }),
      http.delete(`${path}/:commandId`, ({ request, params }) => {
        authorizations.push(request.headers.get("authorization"));
        const scope = scopeOf(params);
        const before = scopes[scope].length;
        scopes[scope] = scopes[scope].filter((command) => {
          return command.id !== params.commandId;
        });
        return before === scopes[scope].length
          ? HttpResponse.json({}, { status: 404 })
          : new HttpResponse(null, { status: 204 });
      }),
    ];
  });
  server.use(...collectionHandlers);

  return { authorizations };
}

async function readCommands(url, token) {
  const response = await globalThis.fetch(url, {
    headers: { Authorization: `Bot ${token}` },
  });
  expect(response.status).toBe(200);
  return response.json();
}

function guildCommand(id, name, type) {
  return {
    id,
    application_id: APPLICATION_ID,
    guild_id: GUILD_ID,
    name,
    type,
    description: type === 1 ? `Legacy ${name}` : "",
  };
}

function globalCommand(id, name) {
  return {
    id,
    application_id: APPLICATION_ID,
    name,
    type: 1,
    description: `Legacy ${name}`,
  };
}

function names(commands) {
  return commands.map((command) => {
    return `${command.name}:${command.type}`;
  });
}

test("register-discord-commands-002 previews guild registration without configuration or token", async () => {
  const output = captureStdout();

  await expect(
    runDiscordCommandRegistration(
      ["--guild", GUILD_ID, "--application-id", APPLICATION_ID],
      {},
    ),
  ).resolves.toBeUndefined();

  const preview = JSON.parse(output());
  expect(preview).toMatchObject({
    mode: "dry-run",
    method: "POST",
    url: GUILD_URL,
    removeCommands: [
      { name: "okou", type: 1 },
      { name: "switch", type: 1 },
      { name: "model", type: 1 },
    ],
  });
  expect(
    preview.commands.map((command) => {
      return command.name;
    }),
  ).toStrictEqual(["help", "connect", "disconnect"]);
  for (const command of preview.commands) {
    expect(command).not.toHaveProperty("contexts");
    expect(command).not.toHaveProperty("integration_types");
  }
});

test("register-discord-commands-006 replaces retired guild commands and preserves unrelated ones", async () => {
  const token = randomUUID();
  const unrelated = [
    guildCommand("300000000000000004", "status", 1),
    guildCommand("300000000000000005", "okou", 2),
    guildCommand("300000000000000006", "model", 3),
  ];
  const discord = discordCommands({
    guild: [
      guildCommand("300000000000000001", "okou", 1),
      guildCommand("300000000000000002", "switch", 1),
      guildCommand("300000000000000003", "model", 1),
      ...unrelated,
    ],
  });
  const output = captureStdout();
  const environment = { DISCORD_BOT_TOKEN: token };
  const args = [
    "--guild",
    GUILD_ID,
    "--application-id",
    APPLICATION_ID,
    "--apply",
  ];

  await runDiscordCommandRegistration(args, environment);
  const afterFirst = await readCommands(GUILD_URL, token);

  expect(
    discord.authorizations.every((authorization) => {
      return authorization === `Bot ${token}`;
    }),
  ).toBeTruthy();
  expect(names(afterFirst)).toStrictEqual([
    "status:1",
    "okou:2",
    "model:3",
    "help:1",
    "connect:1",
    "disconnect:1",
  ]);
  expect(afterFirst.slice(0, 3)).toStrictEqual(unrelated);
  const firstOutput = output();
  expect(firstOutput).toContain(
    "Removed /okou (300000000000000001) from guild",
  );
  expect(firstOutput).toContain(
    "Removed /switch (300000000000000002) from guild",
  );
  expect(firstOutput).toContain(
    "Removed /model (300000000000000003) from guild",
  );
  expect(firstOutput).toContain("Verify /help in the selected scope");
  expect(firstOutput).not.toContain(token);

  await runDiscordCommandRegistration(args, environment);

  await expect(readCommands(GUILD_URL, token)).resolves.toStrictEqual(
    afterFirst,
  );
});

test("register-discord-commands-008 applies global registration without touching guild commands", async () => {
  const token = randomUUID();
  const guildOkou = guildCommand("300000000000000011", "okou", 1);
  discordCommands({
    global: [
      globalCommand("300000000000000012", "okou"),
      globalCommand("300000000000000013", "switch"),
      globalCommand("300000000000000014", "model"),
    ],
    guild: [guildOkou],
  });
  const output = captureStdout();

  await runDiscordCommandRegistration(
    ["--global", "--application-id", APPLICATION_ID, "--apply"],
    { DISCORD_BOT_TOKEN: token },
  );

  const globalCommands = await readCommands(GLOBAL_URL, token);
  expect(
    globalCommands.map((command) => {
      return command.name;
    }),
  ).toStrictEqual(["help", "connect", "disconnect"]);
  await expect(readCommands(GUILD_URL, token)).resolves.toStrictEqual([
    guildOkou,
  ]);
  expect(output()).toContain("global (guilds and bot DMs)");
});

test("register-discord-commands-009 keeps the grouped command when a replacement is rate limited", async () => {
  const token = randomUUID();
  const okou = guildCommand("300000000000000021", "okou", 1);
  discordCommands({
    guild: [okou],
    rejectPost: (body) => {
      return body.name === "disconnect"
        ? HttpResponse.json(
            { message: "You are being rate limited.", retry_after: 2.5 },
            { status: 429, headers: { "Retry-After": "2.5" } },
          )
        : undefined;
    },
  });
  const output = captureStdout();

  await expect(
    runDiscordCommandRegistration(
      ["--guild", GUILD_ID, "--application-id", APPLICATION_ID, "--apply"],
      { DISCORD_BOT_TOKEN: token },
    ),
  ).rejects.toThrow(
    "Discord rate limited registration. Retry after 2.5 seconds.",
  );

  const commands = await readCommands(GUILD_URL, token);
  expect(
    commands.map((command) => {
      return command.name;
    }),
  ).toStrictEqual(["okou", "help", "connect"]);
  expect(commands[0]).toStrictEqual(okou);
  const printed = output();
  expect(printed).toContain("Registered /help");
  expect(printed).toContain("Registered /connect");
  expect(printed).not.toContain("Registered /disconnect");
  expect(printed).not.toContain(token);
});
