import { readFile } from "node:fs/promises";
import { array, strictObject, string, url as zUrl } from "zod";
import {
  userPermissionGrantBatchItemSchema,
  userPermissionGrantBatchItemsSchema,
  type UserPermissionGrantBatchItem,
} from "@okouai/api-contracts/validators/user-permission-grants";
import { memberPermissionUrl } from "./member-permission-url";
import { finalizePermissionActionUrl } from "./action-url";
import { diagnosePermissionRequest } from "./permission-request-diagnostic";

const nonemptyString = string().trim().min(1);
const batchFileSchema = array(
  strictObject({
    connector: nonemptyString,
    permission: userPermissionGrantBatchItemSchema.shape.permission,
    url: zUrl({ protocol: /^https?$/ }),
    method: nonemptyString.max(16),
    awsService: nonemptyString.optional(),
    awsAction: nonemptyString.optional(),
    awsTarget: nonemptyString.optional(),
    awsQueryParam: array(nonemptyString).optional(),
    awsHeaderPresent: array(nonemptyString).optional(),
  }),
)
  .min(1)
  .max(20);

export async function resolvePermissionRequestBatch(args: {
  readonly batchFile: string;
  readonly callbackPrompt: string | undefined;
}) {
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
  const actionUrl = await memberPermissionUrl("batch");
  actionUrl.searchParams.set(
    "items",
    JSON.stringify(userPermissionGrantBatchItemsSchema.parse(items)),
  );
  actionUrl.searchParams.set("action", "allow");
  const url = finalizePermissionActionUrl(actionUrl, args.callbackPrompt);
  if (Buffer.byteLength(url, "utf8") > 8192) {
    throw new Error(
      "Batch permission URL exceeds 8192 UTF-8 bytes. Split the batch into smaller files or shorten the callback prompt.",
    );
  }
  return { items, summaries, hasAws, url };
}
