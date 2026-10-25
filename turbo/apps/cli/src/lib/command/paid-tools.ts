import {
  DISABLED_PAID_TOOLS_ENV_VAR,
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

export function isPaidToolEnabled(tool: PaidToolId): boolean {
  const policy = readPolicy();
  return policy !== null && !policy.has(tool);
}

/** Whole managed families are absent from the run's command tree. */
export function isPaidCommandEnabled(name: string): boolean {
  const tool = paidToolIdSchema.safeParse(name);
  return !tool.success || isPaidToolEnabled(tool.data);
}

async function getPaidToolUnavailableMessage(
  tool: PaidToolId,
): Promise<string | undefined> {
  const policy = readPolicy();
  if (policy === null) {
    return `Paid tool configuration is invalid: ${DISABLED_PAID_TOOLS_ENV_VAR} must contain a JSON array of tool IDs. Start a new run or contact support.`;
  }
  if (!policy.has(tool)) return undefined;

  const settingsUrl = new URL("/", await getPlatformOrigin());
  settingsUrl.searchParams.set("settings", "tools");
  return `Paid tool "${tool}" is disabled for this run. Re-enable it in Settings > Personal > Tools: ${settingsUrl.toString()}\nChanges apply to later runs.`;
}

export async function assertPaidToolEnabled(tool: PaidToolId): Promise<void> {
  const message = await getPaidToolUnavailableMessage(tool);
  if (message) throw new Error(message);
}

function commandPath(program: Command, command: Command): Command[] {
  const path: Command[] = [];
  for (let current: Command | null = command; current !== program;) {
    if (!current?.parent) return [];
    path.unshift(current);
    current = current.parent;
  }
  return path;
}

function researchTool(
  family: string | undefined,
  operation: string | undefined,
): PaidToolId | undefined {
  const toolName =
    family === "web" && operation === "search"
      ? "web-search"
      : family === "web" && operation === "scrape"
        ? "scrape"
        : family === "people" && operation === "search"
          ? "people-search"
          : family;
  const tool = paidToolIdSchema.safeParse(toolName);
  return tool.success ? tool.data : undefined;
}

export function isDataCapabilityEnabled(id: string): boolean {
  const [family, operation] = id.split(".");
  const tool = researchTool(family, operation);
  return isPaidToolEnabled("data-search") && (!tool || isPaidToolEnabled(tool));
}

function isAdvancedDataAction(path: Command[], action: Command): boolean {
  if (path[0]?.name() !== "data") return false;
  const family = path[1]?.name();
  const operation = path[2]?.name();
  if (family === "social") return false;
  if (family === "people" && operation === "search") {
    return action.opts<{ backend?: string }>().backend === "prospect";
  }
  // Advanced adapters share a required execution budget. This also covers new
  // operations nested in historical families without changing their saved IDs.
  return action.options.some((option) => {
    return option.long === "--max-credits";
  });
}

function advancedPaidTools(
  tool: PaidToolId | undefined,
): readonly PaidToolId[] {
  return tool && tool !== "data-search"
    ? [tool, "data-search"]
    : ["data-search"];
}

function isFreeSocialAction(path: Command[], action: Command): boolean {
  const operation = path[2]?.name();
  const jobOperation = path[3]?.name();
  return Boolean(
    action.opts<{ dryRun?: boolean }>().dryRun ||
    (operation === "jobs" &&
      ["list", "get", "cancel"].includes(jobOperation ?? "")) ||
    ["capabilities", "status", "downloads"].includes(operation ?? "") ||
    (operation === "download" &&
      action.opts<{ resume?: string }>().resume !== undefined),
  );
}

function paidToolsForAction(
  program: Command,
  action: Command,
): readonly PaidToolId[] {
  const path = commandPath(program, action);
  const tool =
    path[0]?.name() === "data"
      ? researchTool(path[1]?.name(), path[2]?.name())
      : undefined;
  if (isAdvancedDataAction(path, action)) {
    if (action.opts<{ dryRun?: boolean }>().dryRun) return [];
    return advancedPaidTools(tool);
  }
  if (!tool) return [];
  if (tool === "social" && isFreeSocialAction(path, action)) return [];
  return [tool];
}

/** Enforce the run's personal preference before any command action starts. */
export function installPaidToolPolicy(program: Command): void {
  if (installedPrograms.has(program)) return;
  installedPrograms.add(program);

  program.hook("preAction", (_command, action) => {
    const tools = paidToolsForAction(program, action);
    if (tools.length === 0) return;
    return withErrorHandler(async () => {
      for (const tool of tools) await assertPaidToolEnabled(tool);
    })();
  });
}
