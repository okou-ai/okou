import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { composerDrafts } from "../schema/composer-draft";

describe("composerDrafts schema", () => {
  it("uses canonical physical storage identifiers", () => {
    const config = getTableConfig(composerDrafts);

    expect({
      table: config.name,
      columns: config.columns.map((column) => {
        return column.name;
      }),
      indexes: config.indexes.map((index) => {
        return index.config.name;
      }),
      checks: config.checks.map((check) => {
        return check.name;
      }),
      foreignKeys: config.foreignKeys.map((foreignKey) => {
        return foreignKey.getName();
      }),
    }).toStrictEqual({
      table: "agent_drafts",
      columns: [
        "user_id",
        "org_id",
        "draft_user_message",
        "draft_attachments",
        "created_at",
        "updated_at",
      ],
      indexes: ["idx_agent_drafts_user_org"],
      checks: ["agent_drafts_draft_user_message_check"],
      foreignKeys: [],
    });
  });

  it("exposes canonical document draft storage", () => {
    const columns = new Map(
      getTableConfig(composerDrafts).columns.map((column) => {
        return [column.name, column.notNull] as const;
      }),
    );

    expect(columns.has("draft_structured_prompt")).toBe(false);
    expect(columns.get("draft_user_message")).toBe(false);
  });
});
