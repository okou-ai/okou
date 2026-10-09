import { describe, expect, it } from "vitest";

import { deriveSqlSpanName } from "../sql-span-name";

// Inputs are parameterized SQL templates as produced by drizzle (the same
// strings we set on `db.statement`). drizzle quotes identifiers and uses
// `$N` placeholders, so the cases here mirror real-world payloads.
describe("deriveSqlSpanName", () => {
  describe("supported DML keywords with a quoted target table", () => {
    it('select … from "table"', () => {
      const sql =
        'select "id", "token" from "cli_tokens" where "cli_tokens"."id" = $1 limit $2';
      expect(deriveSqlSpanName(sql)).toBe("SELECT cli_tokens");
    });

    it('insert into "table" … returning', () => {
      const sql =
        'insert into "usage_events" ("model", "count") values ($1, $2) returning "id"';
      expect(deriveSqlSpanName(sql)).toBe("INSERT usage_events");
    });

    it('update "table" set …', () => {
      const sql =
        'update "cli_tokens" set "last_used_at" = $1 where "cli_tokens"."id" = $2';
      expect(deriveSqlSpanName(sql)).toBe("UPDATE cli_tokens");
    });

    it('delete from "table"', () => {
      const sql =
        'delete from "device_codes" where "device_codes"."expires_at" < $1';
      expect(deriveSqlSpanName(sql)).toBe("DELETE device_codes");
    });

    it('merge into "table" (postgres 15+)', () => {
      const sql =
        'merge into "usage_events" using "staging" on "usage_events"."id" = "staging"."id" when matched then update set "count" = "staging"."count"';
      expect(deriveSqlSpanName(sql)).toBe("MERGE usage_events");
    });
  });

  describe("multi-table or sub-select queries pick the first from/into/update/join target", () => {
    it("select joining two tables uses the from table", () => {
      const sql =
        'select "u"."id", "o"."role" from "users" "u" inner join "org_members" "o" on "u"."id" = "o"."user_id"';
      expect(deriveSqlSpanName(sql)).toBe("SELECT users");
    });

    it("insert into … select from other_table uses the into table", () => {
      const sql =
        'insert into "usage_events_daily" ("model", "count") select "model", count(*) from "usage_events" group by "model"';
      expect(deriveSqlSpanName(sql)).toBe("INSERT usage_events_daily");
    });

    it("with cte as (…) … takes the first from inside the cte", () => {
      const sql =
        'with "stale" as (select "id" from "cli_tokens" where "expires_at" < $1) delete from "cli_tokens" using "stale"';
      expect(deriveSqlSpanName(sql)).toBe("WITH cli_tokens");
    });
  });

  describe("postgres-specific syntax", () => {
    it('delete from only "table" (table inheritance) strips only', () => {
      const sql = 'delete from only "audit_log" where "id" < $1';
      expect(deriveSqlSpanName(sql)).toBe("DELETE audit_log");
    });

    it("unquoted system catalog name (drizzle.execute raw sql)", () => {
      expect(
        deriveSqlSpanName("select datname from pg_database where datname = $1"),
      ).toBe("SELECT pg_database");
    });
  });

  describe("operation without a target table", () => {
    it("select 1 has no from, return the operation alone", () => {
      expect(deriveSqlSpanName("select 1")).toBe("SELECT");
    });
  });

  describe("input variations", () => {
    it("is case-insensitive on the leading keyword", () => {
      expect(deriveSqlSpanName('SELECT 1 FROM "users"')).toBe("SELECT users");
      expect(deriveSqlSpanName('Select 1 from "users"')).toBe("SELECT users");
    });

    it("tolerates leading/trailing whitespace", () => {
      expect(deriveSqlSpanName('   select * from "users"   ')).toBe(
        "SELECT users",
      );
    });
  });

  describe("returns null when there is no recognised dml keyword", () => {
    it("empty string", () => {
      expect(deriveSqlSpanName("")).toBeNull();
    });

    it("explain analyze select … (does not start with a dml verb)", () => {
      expect(
        deriveSqlSpanName('explain analyze select 1 from "users"'),
      ).toBeNull();
    });

    it("begin / commit control statements", () => {
      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0003; new non-billing transactions are prohibited.
      expect(deriveSqlSpanName("begin")).toBeNull();
      expect(deriveSqlSpanName("commit")).toBeNull();
    });
  });
});
