import { object, uuid } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { logger } from "../../lib/log";
import { settle } from "../utils";
import { stopWechatPoller, wechatConfigured } from "./wechat-config";
import { command } from "ccstate";
import { sql } from "drizzle-orm";
import { writeDb$ } from "../external/db";

const log = logger("api:wechat:cleanup");
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
    const deleted = parseRawRows(
      object({ id: uuid() }),
      await set(writeDb$).execute(sql`WITH cancelled AS (
      DELETE FROM wechat_connect_attempts WHERE ${scope}
    ) DELETE FROM wechat_connections WHERE ${scope} RETURNING id`),
    );
    signal.throwIfAborted();
    if (wechatConfigured()) {
      const results = await Promise.all(
        deleted.map((row) => {
          return settle(stopWechatPoller(row.id, signal), signal);
        }),
      );
      signal.throwIfAborted();
      if (
        results.some((result) => {
          return !result.ok;
        })
      ) {
        // The receiver also revalidates membership at each ten-minute block.
        log.warn("WeChat receiver cleanup will retry at authorization renewal");
      }
    }
  },
);
