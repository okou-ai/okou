#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import process from "node:process";
import { isDeepStrictEqual, parseArgs } from "node:util";

import { DISCORD_COMMANDS } from "../../turbo/apps/api/src/lib/discord-command-definition.ts";
import { runDiscordCommandRegistration } from "../../turbo/apps/api/scripts/register-discord-commands.mjs";

// Run with Node 24 from any directory. Requires DISCORD_APPLICATION_ID and
// DISCORD_BOT_TOKEN. Default: inspect all installed scopes without writing.
// --apply reconciles only scopes containing retired chat-input commands.
// Output contains command metadata only; a failed request or verification exits 1.
const RETIRED_NAMES = new Set(["okou", "switch", "model"]);
const supportedNames = new Set(DISCORD_COMMANDS.map((entry) => entry.name));

function snowflake(value) {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{16,19}$/.test(value) ||
    BigInt(value) > 18_446_744_073_709_551_615n
  ) {
    throw new Error("Discord returned an invalid identity.");
  }
  return value;
}

async function main() {
  const { values } = parseArgs({
    options: { apply: { type: "boolean", default: false } },
    allowPositionals: false,
    strict: true,
  });
  const applicationId = snowflake(process.env.DISCORD_APPLICATION_ID);
  const token = process.env.DISCORD_BOT_TOKEN;
  if (typeof token !== "string" || !/^[\x21-\x7e]+$/.test(token)) {
    throw new Error("DISCORD_BOT_TOKEN is required.");
  }
  const request = async (path) => {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      headers: { Authorization: `Bot ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Discord inspection failed (HTTP ${response.status}).`);
    }
    return response.json();
  };
  const application = await request("/applications/@me");
  if (application.id !== applicationId) {
    throw new Error("Discord bot does not belong to the selected application.");
  }

  const guildIds = new Set();
  let after = "0";
  for (;;) {
    const page = await request(`/users/@me/guilds?limit=200&after=${after}`);
    if (!Array.isArray(page) || page.length > 200) {
      throw new Error("Discord returned an invalid guild page.");
    }
    for (const guild of page) {
      const id = snowflake(guild.id);
      if (BigInt(id) <= BigInt(after) || guildIds.has(id)) {
        throw new Error("Discord guild pagination did not advance.");
      }
      guildIds.add(id);
    }
    if (page.length < 200) {
      break;
    }
    after = page.reduce((maximum, guild) => {
      return BigInt(guild.id) > BigInt(maximum) ? guild.id : maximum;
    }, after);
  }

  const readCommands = async (guildId) => {
    const scopePath = guildId ? `/guilds/${guildId}` : "";
    const entries = await request(
      `/applications/${applicationId}${scopePath}/commands`,
    );
    if (!Array.isArray(entries)) {
      throw new Error("Discord returned an invalid command list.");
    }
    for (const entry of entries) {
      snowflake(entry.id);
      if (
        entry.application_id !== applicationId ||
        entry.guild_id !== guildId
      ) {
        throw new Error("Discord returned a command from an unexpected scope.");
      }
    }
    return entries;
  };
  const isRetired = (entry) =>
    entry.type === 1 && RETIRED_NAMES.has(entry.name);
  const scopes = [];
  // Complete discovery before permitting any write.
  for (const guildId of [undefined, ...guildIds]) {
    const before = await readCommands(guildId);
    const retired = before.filter(isRetired);
    scopes.push({ guildId, before, retired });
    console.log(
      JSON.stringify({
        scope: guildId ?? "global",
        commands: before.map(({ id, name, type }) => ({ id, name, type })),
        remove: retired.map(({ id, name }) => ({ id, name })),
      }),
    );
  }

  let reconciledScopes = 0;
  for (const scope of scopes) {
    if (!values.apply || scope.retired.length === 0) {
      continue;
    }
    await runDiscordCommandRegistration([
      ...(scope.guildId ? ["--guild", scope.guildId] : ["--global"]),
      "--apply",
    ]);
    reconciledScopes++;
  }

  if (values.apply) {
    for (const scope of scopes) {
      const afterCommands = await readCommands(scope.guildId);
      if (afterCommands.some(isRetired)) {
        throw new Error("Retired Discord commands remain after cleanup.");
      }
      const expected = scope.before.filter((entry) => !isRetired(entry));
      for (const entry of expected) {
        const current = afterCommands.find(
          (candidate) => candidate.id === entry.id,
        );
        if (
          !current ||
          current.name !== entry.name ||
          current.type !== entry.type ||
          ((entry.type !== 1 || !supportedNames.has(entry.name)) &&
            !isDeepStrictEqual(current, entry))
        ) {
          throw new Error("An existing Discord command was not preserved.");
        }
      }
      if (
        scope.retired.length > 0 &&
        [...supportedNames].some(
          (name) =>
            !afterCommands.some(
              (entry) => entry.type === 1 && entry.name === name,
            ),
        )
      ) {
        throw new Error(
          "Supported Discord commands are missing after cleanup.",
        );
      }
      console.log(
        JSON.stringify({
          verifiedScope: scope.guildId ?? "global",
          commands: afterCommands.map(({ id, name, type }) => ({
            id,
            name,
            type,
          })),
        }),
      );
    }
  }
  const summary = {
    mode: values.apply ? "applied-and-verified" : "preview",
    applicationId,
    guilds: guildIds.size,
    scopes: scopes.length,
    plannedRemovals: scopes.reduce(
      (count, scope) => count + scope.retired.length,
      0,
    ),
    reconciledScopes,
  };
  console.log(JSON.stringify(summary));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### Discord command cleanup\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`,
    );
  }
}

try {
  await main();
} catch (error) {
  // Provider bodies and credentials are never included in diagnostics.
  console.error(
    error instanceof SyntaxError
      ? "Discord returned invalid JSON."
      : error instanceof Error
        ? error.message
        : "Discord cleanup failed.",
  );
  process.exitCode = 1;
}
