import {
  whatsappConnectionCodes,
  whatsappUserLinks,
} from "@okouai/db/schema/whatsapp";
import { command } from "ccstate";
import { and, eq, getTableColumns, gt, isNull, or, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import type { AgentPhoneUserLink } from "./agentphone-shared.service";
import { whatsappEnabled$ } from "./whatsapp-config";

export const linkWhatsappIdentity$ = command(
  async (
    { set },
    args: { readonly codeHash: string; readonly phoneHandle: string },
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "invalid" }
    | {
        readonly kind: "conflict";
        readonly reason: "phone-handle-linked" | "org-linked" | "conflict";
      }
    | { readonly kind: "linked"; readonly userLink: AgentPhoneUserLink }
  > => {
    const db = set(writeDb$);
    const at = nowDate();
    const codes = whatsappConnectionCodes;
    const candidates = await db
      .select()
      .from(codes)
      .where(
        and(
          eq(codes.codeHash, args.codeHash),
          isNull(codes.consumedAt),
          gt(codes.expiresAt, at),
        ),
      )
      .limit(2);
    signal.throwIfAborted();
    const candidate = candidates[0];
    if (
      candidates.length !== 1 ||
      !candidate ||
      !(await set(whatsappEnabled$, candidate.orgId, candidate.userId, signal))
    ) {
      return { kind: "invalid" };
    }

    const consumed = db.$with("consumed_whatsapp_code").as(
      db
        .update(codes)
        .set({
          consumedAt: at,
          consumedPhoneHandle: args.phoneHandle,
          updatedAt: at,
        })
        .where(
          and(
            eq(codes.id, candidate.id),
            eq(codes.codeHash, args.codeHash),
            isNull(codes.consumedAt),
            gt(codes.expiresAt, at),
            sql`(SELECT count(*) FROM (SELECT 1 FROM ${codes} AS active_code
      WHERE active_code.code_hash = ${args.codeHash} AND active_code.consumed_at IS NULL
      AND active_code.expires_at > ${sql.param(at, codes.expiresAt)} LIMIT 2) AS matching) = 1`,
          ),
        )
        .returning({ userId: codes.userId, orgId: codes.orgId }),
    );
    const links = whatsappUserLinks;
    const inserted = db.$with("inserted_whatsapp_link", getTableColumns(links))
      .as(sql`
    INSERT INTO ${links} (phone_handle, user_id, org_id)
    SELECT ${args.phoneHandle}, ${consumed.userId}, ${consumed.orgId} FROM ${consumed}
    WHERE true ON CONFLICT DO NOTHING RETURNING *
  `);
    // Code consumption and link publication commit together. A concurrent loser
    // cannot create another link from the same code.
    const [published] = await db
      .with(consumed, inserted)
      .select({
        link: {
          id: inserted.id,
          phoneHandle: inserted.phoneHandle,
          userId: inserted.userId,
          orgId: inserted.orgId,
          createdAt: inserted.createdAt,
          updatedAt: inserted.updatedAt,
        },
      })
      .from(consumed)
      .leftJoin(inserted, sql`true`);
    signal.throwIfAborted();
    if (!published) {
      return { kind: "invalid" };
    }
    if (published.link) {
      return { kind: "linked", userLink: published.link };
    }
    const existing = await db
      .select()
      .from(links)
      .where(
        or(
          eq(links.phoneHandle, args.phoneHandle),
          and(
            eq(links.userId, candidate.userId),
            eq(links.orgId, candidate.orgId),
          ),
        ),
      )
      .limit(2);
    signal.throwIfAborted();
    const same = existing.find((link) => {
      return (
        link.phoneHandle === args.phoneHandle &&
        link.userId === candidate.userId &&
        link.orgId === candidate.orgId
      );
    });
    if (same) {
      return { kind: "linked", userLink: same };
    }
    return {
      kind: "conflict",
      reason: existing.some((link) => {
        return link.phoneHandle === args.phoneHandle;
      })
        ? "phone-handle-linked"
        : "org-linked",
    };
  },
);
