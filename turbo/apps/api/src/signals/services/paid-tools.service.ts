import type { PaidToolId } from "@okouai/api-contracts/contracts/paid-tools";
import { userDisabledPaidTools } from "@okouai/db/schema/user-disabled-paid-tools";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../external/db";

export const updateDisabledPaidTool$ = command(
  async (
    { set },
    input: {
      readonly orgId: string;
      readonly userId: string;
      readonly toolId: PaidToolId;
      readonly disabled: boolean;
    },
  ): Promise<void> => {
    const db = set(writeDb$);
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
  },
);
