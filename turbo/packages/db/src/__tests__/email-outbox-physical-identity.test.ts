import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { emailOutbox as runtimeEmailOutbox } from "../runtime/email-outbox";
import { emailOutbox } from "../schema/email-outbox";

describe("email outbox physical identity", () => {
  it("keeps the provider replay identity and exact constraints", () => {
    const config = getTableConfig(emailOutbox);

    expect(config.name).toBe("email_outbox");
    expect(config.columns).toEqual(
      expect.arrayContaining([
        // Additive delivery-identity columns stay nullable for rows enqueued by
        // a producer and for rows written before they existed.
        expect.objectContaining({
          name: "provider_idempotency_key",
          notNull: false,
        }),
        expect.objectContaining({ name: "provider_request", notNull: false }),
      ]),
    );
    expect(config.foreignKeys).toStrictEqual([]);
    expect(
      config.indexes
        .flatMap((index) => {
          return index.config.name ? [index.config.name] : [];
        })
        .sort(),
    ).toStrictEqual([
      "email_outbox_created_at_idx",
      "email_outbox_drain_idx",
      "email_outbox_provider_idempotency_key_unique",
    ]);
    expect(config.checks).toStrictEqual([]);
  });

  it("maps every physical outbox column at runtime", () => {
    const columnNames = (table: Parameters<typeof getTableConfig>[0]) => {
      return getTableConfig(table)
        .columns.map(({ name }) => {
          return name;
        })
        .sort();
    };

    expect(getTableConfig(runtimeEmailOutbox).name).toBe("email_outbox");
    expect(columnNames(runtimeEmailOutbox)).toStrictEqual(
      columnNames(emailOutbox),
    );
  });
});
