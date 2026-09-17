import { command } from "ccstate";
import { userTemplates } from "@okouai/db/schema/user-template";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../external/db";

interface DeletedUserTemplate {
  readonly visibility: "private" | "organization";
}

export const deleteUserTemplate$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly templateId: string;
    },
    signal: AbortSignal,
  ): Promise<DeletedUserTemplate | null> => {
    // The source and page objects are normal user uploads. Deleting a template
    // must not delete independently owned attachments that may be reused
    // elsewhere, so this removes the record and nothing else.
    //
    // Concurrent deletes of the same template need no marker column or advisory
    // lock: the row lock a single `DELETE ... RETURNING` takes already lets
    // exactly one caller observe the row, and the loser returns nothing.
    const [deleted] = await set(writeDb$)
      .delete(userTemplates)
      .where(
        and(
          eq(userTemplates.id, args.templateId),
          eq(userTemplates.orgId, args.orgId),
          eq(userTemplates.ownerUserId, args.ownerUserId),
        ),
      )
      .returning({ visibility: userTemplates.visibility });
    signal.throwIfAborted();
    return deleted ?? null;
  },
);
