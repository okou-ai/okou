import {
  DISABLED_PAID_TOOLS_ENV_VAR,
  PAID_TOOL_IDS,
  paidToolIdSchema,
  type PaidToolId,
} from "@okouai/api-contracts/contracts/paid-tools";
import type { Command } from "commander";
import { z } from "zod";

import { getPlatformOrigin } from "../platform-url";
import { withErrorHandler } from "./with-error-handler";

const installedPrograms = new WeakSet<Command>();
const disabledToolsSchema = z.array(z.string());

function readPolicy(): ReadonlySet<string> | null {
  const value = process.env[DISABLED_PAID_TOOLS_ENV_VAR];
  if (!value?.trim()) return new Set();

  try {
    const parsed = disabledToolsSchema.safeParse(JSON.parse(value));
    return parsed.success ? new Set(parsed.data) : null;
  } catch {
    return null;
  }
}

function commandPath(program: Command, command: Command): Command[] {
  const path: Command[] = [];
  for (let current: Command | null = command; current !== program; ) {
    if (!current?.parent) return [];
    path.unshift(current);
    current = current.parent;
  }
  return path;
}

function paidToolForAction(
  program: Command,
  action: Command,
): PaidToolId | undefined {
  const path = commandPath(program, action);
  const tool = paidToolIdSchema.safeParse(path[0]?.name());
  if (!tool.success) return undefined;

  if (tool.data === "social") {
    const operation = path[1]?.name();
    if (
      operation === "capabilities" ||
      operation === "status" ||
      operation === "downloads" ||
      (operation === "download" &&
        action.opts<{ resume?: string }>().resume !== undefined)
    ) {
      return undefined;
    }
  }

  return tool.data;
}

/** Enforce the run's personal preference before any command action starts. */
export function installPaidToolPolicy(program: Command): void {
  if (installedPrograms.has(program)) return;
  installedPrograms.add(program);

  program.hook("preAction", (_command, action) => {
    const tool = paidToolForAction(program, action);
    if (!tool) return;
    const policy = readPolicy();
    if (policy !== null && !policy.has(tool)) return;

    return withErrorHandler(async () => {
      if (policy === null) {
        throw new Error(
          `Paid tool configuration is invalid: ${DISABLED_PAID_TOOLS_ENV_VAR} must contain a JSON array of tool IDs. Start a new run or contact support.`,
        );
      }
      const settingsUrl = new URL("/", await getPlatformOrigin());
      settingsUrl.searchParams.set("settings", "paid-tools");
      throw new Error(
        `Paid tool "${tool}" is disabled for this run. Re-enable it in Settings > Personal > Paid tools: ${settingsUrl.toString()}\nChanges apply to later runs.`,
      );
    })();
  });

  program.addHelpText("afterAll", ({ command }) => {
    const policy = readPolicy();
    if (policy === null) {
      return "\nPaid tools are unavailable because this run's paid-tool configuration is invalid. Help and free operations remain available.";
    }
    const family = commandPath(program, command)[0]?.name();
    const disabled = PAID_TOOL_IDS.filter((tool) => {
      return policy.has(tool) && (family === undefined || family === tool);
    });
    if (disabled.length === 0) return "";

    return `\nDisabled paid tools in this run: ${disabled.join(", ")}.\nManage them in Settings > Personal > Paid tools. Help and free operations remain available.`;
  });
}
