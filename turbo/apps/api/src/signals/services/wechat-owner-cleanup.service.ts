import { command } from "ccstate";
import { sql } from "drizzle-orm";
import { writeDb$ } from "../external/db";

type Owner =
  | { readonly kind: "owner"; readonly orgId: string; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string }
  | { readonly kind: "user"; readonly userId: string };

/** Delete credentials and reply capabilities, retaining canonical conversation events. */
export const deleteWechatOwnerData$ = command(
  async ({ set }, owner: Owner, signal: AbortSignal) => {
    const scope =
      owner.kind === "owner"
        ? sql`org_id=${owner.orgId} AND user_id=${owner.userId}`
        : owner.kind === "organization"
          ? sql`org_id=${owner.orgId}`
          : sql`user_id=${owner.userId}`;
    await set(writeDb$).execute(sql`WITH cancelled AS (
      DELETE FROM wechat_connect_attempts WHERE ${scope}
    ) DELETE FROM wechat_connections WHERE ${scope}`);
    signal.throwIfAborted();
  },
);
