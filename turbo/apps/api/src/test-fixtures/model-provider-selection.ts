import { modelProviders } from "@okouai/db/schema/model-provider";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";

/** Single-secret provider APIs manage credentials; historical rows can retain model selections. */
export async function setHistoricalModelProviderSelectionFixture(args: {
  readonly orgId: string;
  readonly providerId: string;
  readonly selectedModel: string;
}): Promise<void> {
  const rows = await db()
    .update(modelProviders)
    .set({ selectedModel: args.selectedModel })
    .where(
      and(
        eq(modelProviders.id, args.providerId),
        eq(modelProviders.orgId, args.orgId),
      ),
    )
    .returning({ id: modelProviders.id });
  if (rows.length !== 1) {
    throw new Error(
      "Expected one historical model provider selection to update",
    );
  }
}
