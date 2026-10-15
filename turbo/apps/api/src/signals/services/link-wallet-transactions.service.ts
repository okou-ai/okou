import {
  walletTransactionSchema,
  walletUserContract,
} from "@okouai/api-contracts/contracts/wallet";
import { linkWalletSpends } from "@okouai/db/schema/link-wallet";
import { computed } from "ccstate";
import { and, desc, eq, sql } from "drizzle-orm";
import { organizationAuthContext$ } from "../auth/auth-context";
import { queryOf } from "../context/request";
import { db$ } from "../external/db";

const query$ = queryOf(walletUserContract.transactions);

export const walletTransactions$ = computed(async (get) => {
  const { orgId, userId } = get(organizationAuthContext$);
  const { cursor, limit } = get(query$);
  const db = get(db$);
  const owner = and(
    eq(linkWalletSpends.orgId, orgId),
    eq(linkWalletSpends.userId, userId),
  );
  // Compare in Postgres to retain timestamp precision, including tied dates.
  // A missing cursor or one owned by someone else yields no rows.
  const before = cursor
    ? sql`(${linkWalletSpends.createdAt}, ${linkWalletSpends.id}) < (${db
        .select({
          createdAt: linkWalletSpends.createdAt,
          id: linkWalletSpends.id,
        })
        .from(linkWalletSpends)
        .where(and(owner, eq(linkWalletSpends.id, cursor)))})`
    : undefined;
  const rows = await db
    .select({
      id: linkWalletSpends.id,
      status: linkWalletSpends.status,
      amount: linkWalletSpends.amount,
      currency: linkWalletSpends.currency,
      merchantName: linkWalletSpends.merchantName,
      test: linkWalletSpends.test,
      createdAt: linkWalletSpends.createdAt,
    })
    .from(linkWalletSpends)
    .where(and(owner, before))
    .orderBy(desc(linkWalletSpends.createdAt), desc(linkWalletSpends.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    transactions: page.map((row) => {
      return walletTransactionSchema.parse({
        ...row,
        createdAt: row.createdAt.toISOString(),
      });
    }),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
});
