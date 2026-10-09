import type { PaidToolId } from "@okouai/api-contracts/contracts/paid-tools";
import { userDisabledPaidTools } from "@okouai/db/schema/user-disabled-paid-tools";
import { and, asc, eq } from "drizzle-orm";
import { command } from "ccstate";

import { db$, type Db } from "../external/db";

export const readDisabledPaidTools$ = command(
  async (
    { get },
    owner: { readonly orgId: string; readonly userId: string },
  ): Promise<string[]> => {
    const rows = await get(db$)
      .select({ toolId: userDisabledPaidTools.toolId })
      .from(userDisabledPaidTools)
      .where(
        and(
          eq(userDisabledPaidTools.orgId, owner.orgId),
          eq(userDisabledPaidTools.userId, owner.userId),
        ),
      )
      .orderBy(asc(userDisabledPaidTools.toolId));
    return rows.map((row) => {
      return row.toolId;
    });
  },
);

export async function updateDisabledPaidTool(
  db: Pick<Db, "insert" | "delete">,
  input: {
    readonly orgId: string;
    readonly userId: string;
    readonly toolId: PaidToolId;
    readonly disabled: boolean;
  },
): Promise<void> {
  if (input.disabled) {
    await db
      .insert(userDisabledPaidTools)
      .values({
        orgId: input.orgId,
        userId: input.userId,
        toolId: input.toolId,
      })
      .onConflictDoNothing({
        target: [
          userDisabledPaidTools.orgId,
          userDisabledPaidTools.userId,
          userDisabledPaidTools.toolId,
        ],
      });
    return;
  }
  await db
    .delete(userDisabledPaidTools)
    .where(
      and(
        eq(userDisabledPaidTools.orgId, input.orgId),
        eq(userDisabledPaidTools.userId, input.userId),
        eq(userDisabledPaidTools.toolId, input.toolId),
      ),
    );
}
