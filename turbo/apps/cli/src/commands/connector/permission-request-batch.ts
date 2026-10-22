import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  userPermissionGrantBatchItemSchema,
  userPermissionGrantBatchItemsSchema,
  type UserPermissionGrantBatchItem,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import { getPlatformOrigin } from "../../lib/platform-url";
import { finalizeActionUrl } from "./action-url";
import { diagnosePermissionRequest } from "./permission-request-diagnostic";

const nonemptyString = z.string().trim().min(1);
const batchFileSchema = z
  .array(
    z.strictObject({
      connector: nonemptyString,
      permission: userPermissionGrantBatchItemSchema.shape.permission,
      url: z.url({ protocol: /^https?$/ }),
      method: nonemptyString.max(16),
      awsService: nonemptyString.optional(),
      awsAction: nonemptyString.optional(),
      awsTarget: nonemptyString.optional(),
      awsQueryParam: z.array(nonemptyString).optional(),
      awsHeaderPresent: z.array(nonemptyString).optional(),
    }),
  )
  .min(1)
  .max(20);

export async function resolvePermissionRequestBatch(args: {
  readonly batchFile: string;
  readonly agentId: string | undefined;
  readonly callbackPrompt: string | undefined;
}) {
  const agentId = args.agentId?.trim();
  if (!agentId || agentId !== args.agentId) {
    throw new Error(
      "Batch permission requests require a current Agent or --agent <id>.",
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(await readFile(args.batchFile, "utf8"));
  } catch {
    throw new Error(
      "Cannot read batch JSON. Supply --batch-file with a readable JSON file.",
    );
  }
  const parsed = batchFileSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      "Invalid batch file: expected 1–20 strict items with connector, permission, url, method and optional AWS diagnostic selectors.",
    );
  }
  const items: UserPermissionGrantBatchItem[] = [];
  const seen = new Set<string>();
  const summaries: string[] = [];
  let hasAws = false;
  for (const [index, item] of parsed.data.entries()) {
    const result = await diagnosePermissionRequest(
      item.connector,
      item.permission,
      item,
    );
    hasAws ||= result.request.aws !== undefined;
    const allowed = result.policy.outcome === "allow";
    summaries.push(
      `Item ${index + 1}: ${result.connectorSlug} / ${item.permission}: ${allowed ? "already allowed; skipped" : result.policy.outcome}`,
    );
    // Diagnose every input, even when its grant was already included for another endpoint.
    if (allowed) continue;
    const key = JSON.stringify([result.connectorSlug, item.permission]);
    if (!seen.has(key)) {
      seen.add(key);
      items.push({
        connectorSlug: result.connectorSlug,
        permission: item.permission,
      });
    }
  }
  if (items.length === 0) return { items, summaries, hasAws, url: undefined };
  const actionUrl = new URL(
    `/agents/${encodeURIComponent(agentId)}/permissions/batch`,
    await getPlatformOrigin(),
  );
  actionUrl.searchParams.set(
    "items",
    JSON.stringify(userPermissionGrantBatchItemsSchema.parse(items)),
  );
  actionUrl.searchParams.set("action", "allow");
  const url = finalizeActionUrl(actionUrl, args.callbackPrompt, agentId);
  if (Buffer.byteLength(url, "utf8") > 8192) {
    throw new Error(
      "Batch permission URL exceeds 8192 UTF-8 bytes. Split the batch into smaller files or shorten the callback prompt.",
    );
  }
  return { items, summaries, hasAws, url };
}
