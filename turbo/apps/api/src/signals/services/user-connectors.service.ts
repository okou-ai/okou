import { Buffer } from "node:buffer";
import { command } from "ccstate";
import { sql } from "drizzle-orm";
import { array, object, string } from "zod";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";

import { parseRawRows } from "../../lib/db-raw-rows";
import { writeDb$ } from "../external/db";

type UpdateUserBuiltinConnectorsResult =
  | {
      readonly status: "updated";
      readonly enabledConnectorSlugs: readonly ConnectorSlug[];
    }
  | { readonly status: "agentNotFound" };

type UserBuiltinConnectorUpdateOperation = "replace" | "add" | "remove";

const builtinConnectorSelectionRowSchema = object({
  connector_slugs: array(string()),
});

/** Admit slug text only after the routine's existing Agent authorization lock. */
function builtinConnectorSelectionPayload(slugs: readonly ConnectorSlug[]) {
  return Buffer.from(
    JSON.stringify(
      slugs.map((slug) => {
        return Buffer.from(slug, "utf8").toString("base64");
      }),
    ),
    "utf8",
  );
}

export const updateUserBuiltinConnectors$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly agentId: string;
      readonly enabledConnectorSlugs: readonly ConnectorSlug[];
      readonly operation?: UserBuiltinConnectorUpdateOperation;
    },
  ): Promise<UpdateUserBuiltinConnectorsResult> => {
    const db = set(writeDb$);
    const enabledConnectorSlugs = Array.from(
      new Set(args.enabledConnectorSlugs),
    );
    const operation = args.operation ?? "replace";

    const [selection] = parseRawRows(
      builtinConnectorSelectionRowSchema,
      await db.execute(sql`
        SELECT connector_slugs FROM public.update_user_builtin_connectors(
          ${args.orgId}, ${args.userId}, ${args.agentId}::uuid, ${operation},
          ${builtinConnectorSelectionPayload(enabledConnectorSlugs)}::bytea
        )
      `),
    );
    if (!selection) {
      return { status: "agentNotFound" };
    }
    return {
      status: "updated",
      enabledConnectorSlugs:
        operation === "replace"
          ? enabledConnectorSlugs
          : selection.connector_slugs,
    };
  },
);
