import type { DataRouterTool } from "@okouai/api-contracts/contracts/data-router-tools";
import {
  DISABLED_PAID_TOOLS_ENV_VAR,
  paidToolIdSchema,
  type PaidToolId,
} from "@okouai/api-contracts/contracts/paid-tools";
import { z } from "zod";

import { getPlatformOrigin } from "../platform-url";

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

export function isDataRouterToolEnabled(tool: DataRouterTool): boolean {
  const metadata = tool._meta?.["ai.okou/data"];
  return Boolean(
    metadata &&
    isPaidToolEnabled(metadata.family) &&
    isPaidToolEnabled(`data:${tool.name}`),
  );
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
