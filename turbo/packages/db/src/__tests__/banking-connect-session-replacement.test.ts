import { sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { prepareBankingConnectSessionReplacement } from "../operations/banking-connect-session-replacement";

describe("banking connect replacement SQL contract", () => {
  it.each(["connect", "fix"] as const)(
    "compiles the owner gate, partial arbiter, dependent insert and typed %s projection",
    (mode) => {
      const prepared = prepareBankingConnectSessionReplacement({
        id: "00000000-0000-4000-8000-000000000001",
        connectionId: "00000000-0000-4000-8000-000000000002",
        orgId: "org_'$owner",
        userId: "user_'$owner",
        mode,
        institutionLoginId: mode === "fix" ? "institution_'$id" : null,
        updatedAt: new Date("2026-01-02T03:04:05.006Z"),
      });
      const query = new QueryBuilder()
        .with(...prepared.ctes)
        .select(prepared.selection)
        .from(prepared.lockedConnection)
        .leftJoin(prepared.pending, sql`true`);
      // These are the actual sessionless fragments consumed by the command,
      // not a substitute handwritten statement or a privately seeded API case.
      expect(query.toSQL()).toMatchSnapshot();
    },
  );
});
