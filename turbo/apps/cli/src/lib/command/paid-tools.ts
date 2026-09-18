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

export async function getPaidToolUnavailableMessage(
  tool: PaidToolId,
): Promise<string | undefined> {
  const policy = readPolicy();
  if (policy === null) {
    return `Paid tool configuration is invalid: ${DISABLED_PAID_TOOLS_ENV_VAR} must contain a JSON array of tool IDs. Start a new run or contact support.`;
  }
  if (!policy.has(tool)) return undefined;

  const settingsUrl = new URL("/", await getPlatformOrigin());
  settingsUrl.searchParams.set("settings", "paid-tools");
  return `Paid tool "${tool}" is disabled for this run. Re-enable it in Settings > Personal > Paid tools: ${settingsUrl.toString()}\nChanges apply to later runs.`;
}

export async function assertPaidToolEnabled(tool: PaidToolId): Promise<void> {
  const message = await getPaidToolUnavailableMessage(tool);
  if (message) throw new Error(message);
}

export function getGenerationPaidTool(type: string): PaidToolId | undefined {
  switch (type) {
    case "image":
    case "image-batch":
      return "image-generation";
    case "video":
      return "video-generation";
    case "voice":
      return "voice-generation";
    case "avatar-video":
      return "avatar-video-generation";
    default:
      return undefined;
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

function paidToolsForHelp(path: Command[]): readonly PaidToolId[] {
  const family = path[0]?.name();
  if (family === undefined) return PAID_TOOL_IDS;
  if (family === "generate") {
    const type = path[1]?.name();
    if (type === undefined) {
      return [
        "image-generation",
        "video-generation",
        "voice-generation",
        "avatar-video-generation",
      ];
    }
    const tool = getGenerationPaidTool(type);
    return tool ? [tool] : [];
  }
  if (family === "video") {
    return path[1] === undefined || path[1].name() === "render"
      ? ["video-rendering"]
      : [];
  }
  if (family === "__intro-video-agent") return ["video-generation"];
  if (family === "__intro-video-presenter") return ["avatar-video-generation"];
  if (family === "__intro-video-voice") return ["voice-generation"];
  const tool = paidToolIdSchema.safeParse(family);
  return tool.success ? [tool.data] : [];
}

/** Enforce the run's personal preference before any command action starts. */
export function installPaidToolPolicy(program: Command): void {
  if (installedPrograms.has(program)) return;
  installedPrograms.add(program);

  program.hook("preAction", (_command, action) => {
    const tool = paidToolForAction(program, action);
    if (!tool) return;
    return withErrorHandler(async () => {
      await assertPaidToolEnabled(tool);
    })();
  });

  program.addHelpText("afterAll", ({ command }) => {
    const policy = readPolicy();
    if (policy === null) {
      return "\nPaid tools are unavailable because this run's paid-tool configuration is invalid. Help and free operations remain available.";
    }
    const disabled = paidToolsForHelp(commandPath(program, command)).filter(
      (tool) => {
        return policy.has(tool);
      },
    );
    if (disabled.length === 0) return "";

    return `\nDisabled paid tools in this run: ${disabled.join(", ")}.\nManage them in Settings > Personal > Paid tools. Help and free operations remain available.`;
  });
}
