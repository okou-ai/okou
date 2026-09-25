#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { DISCORD_OKOU_COMMAND } from "../src/lib/discord-command-definition.ts";

const HELP = `Usage: pnpm --filter api discord:register [options]

Preview /okou registration in an explicitly selected test guild by default.
Only --apply writes to Discord. The named command is upserted; other application
commands are preserved. This tool never configures credentials or feature flags.

Options:
  --guild <id>           Test guild to register in (required without --global)
  --global               Select global registration, including bot DMs
  --application-id <id>  Application ID (or DISCORD_APPLICATION_ID)
  --apply                Perform the registration (default: dry-run JSON)
  -h, --help             Print this help

Environment:
  DISCORD_APPLICATION_ID  Discord application ID
  DISCORD_BOT_TOKEN       Bot token; required only with --apply

Examples (run from turbo/):
  pnpm --filter api discord:register --guild <test-guild-id>
  pnpm --filter api discord:register --guild <test-guild-id> --apply

Guild commands are unavailable in bot DMs. To test DMs, use a separate test
application and explicitly select --global. Register only after the interaction
endpoint is deployed and configured in Discord. Production registration requires
separate rollout authorization; this command is never part of deployment.
`;

function requireSnowflake(value, name) {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{16,19}$/.test(value) ||
    BigInt(value) > 18_446_744_073_709_551_615n
  ) {
    throw new Error(`${name} must be a valid Discord snowflake ID.`);
  }
  return value;
}

function registrationFailure(response) {
  const retryAfter = response.headers.get("retry-after");
  const guidance =
    response.status === 429
      ? `Discord rate limited registration. Retry after ${retryAfter && /^\d+(\.\d+)?$/.test(retryAfter) ? `${retryAfter} seconds` : "the provider cooldown"}.`
      : "Check the application ID, bot token, and bot installation in the target guild.";
  return new Error(
    `Discord registration failed (HTTP ${response.status}). ${guidance}`,
  );
}

function registeredCommandId(registered, applicationId, guildId) {
  if (
    registered === null ||
    typeof registered !== "object" ||
    registered.application_id !== applicationId ||
    registered.name !== DISCORD_OKOU_COMMAND.name ||
    registered.type !== DISCORD_OKOU_COMMAND.type ||
    registered.guild_id !== guildId
  ) {
    throw new Error("Discord returned an unexpected command registration.");
  }
  return requireSnowflake(registered.id, "Registered command ID");
}

/**
 * Standalone administration boundary: do not import API server configuration,
 * which would require unrelated database, billing, and provider credentials.
 */
export async function runDiscordCommandRegistration(
  args,
  environment = process.env,
) {
  const { values } = parseArgs({
    args,
    options: {
      guild: { type: "string" },
      global: { type: "boolean", default: false },
      "application-id": { type: "string" },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.global && values.guild !== undefined) {
    throw new Error("Choose either --guild <test-guild-id> or --global.");
  }
  if (!values.global && values.guild === undefined) {
    throw new Error(
      "Specify --guild <test-guild-id>. Global registration requires --global.",
    );
  }

  const applicationId = requireSnowflake(
    values["application-id"] ?? environment.DISCORD_APPLICATION_ID,
    "DISCORD_APPLICATION_ID or --application-id",
  );
  const guildId = values.global
    ? undefined
    : requireSnowflake(values.guild, "--guild");
  const scope = guildId ? `guild ${guildId}` : "global (guilds and bot DMs)";
  const url = guildId
    ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${applicationId}/commands`;
  // Discord accepts contexts and installation types only for global commands.
  const {
    contexts: _contexts,
    integration_types: _types,
    ...guildCommand
  } = DISCORD_OKOU_COMMAND;
  const command = guildId ? guildCommand : DISCORD_OKOU_COMMAND;

  if (!values.apply) {
    process.stdout.write(
      `${JSON.stringify({ mode: "dry-run", scope, method: "POST", url, command }, null, 2)}\n`,
    );
    return;
  }

  const token = environment.DISCORD_BOT_TOKEN;
  if (typeof token !== "string" || !/^[\x21-\x7e]+$/.test(token)) {
    throw new Error(
      "Set DISCORD_BOT_TOKEN to a valid token without whitespace before using --apply.",
    );
  }

  const response = await globalThis.fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw registrationFailure(response);
  }

  const commandId = registeredCommandId(
    await response.json(),
    applicationId,
    guildId,
  );
  process.stdout.write(
    `Registered /okou (${commandId}) for ${scope}. Verify /okou help in the selected scope.\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await runDiscordCommandRegistration(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Discord registration failed."}\n`,
    );
    process.exitCode = 1;
  }
}
