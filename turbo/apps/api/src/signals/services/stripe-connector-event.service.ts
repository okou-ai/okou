import { connectors } from "@okouai/db/schema/connector";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";

const eventTypeSchema = z.object({ type: z.string().trim().min(1).max(255) });
const deauthorizationSchema = z.object({
  id: z.string().trim().min(1).max(255),
  type: z.literal("account.application.deauthorized"),
  account: z.string().trim().min(1).max(255).optional(),
  livemode: z.boolean(),
  created: z.number().int().nonnegative().max(8_640_000_000_000),
  data: z.object({ object: z.unknown() }),
});
const liveDeauthorizationSchema = deauthorizationSchema.extend({
  account: z.string().trim().min(1).max(255),
  livemode: z.literal(true),
});

export const dispatchStripeConnectorEvent$ = command(
  async (
    { set },
    event: unknown,
    signal: AbortSignal,
  ): Promise<"ok" | "bad_request"> => {
    const type = eventTypeSchema.safeParse(event);
    if (!type.success) {
      return "bad_request";
    }
    if (type.data.type !== "account.application.deauthorized") {
      return "ok";
    }
    const supported = deauthorizationSchema.safeParse(event);
    if (!supported.success) {
      return "bad_request";
    }
    if (!supported.data.livemode) {
      return "ok";
    }
    const parsed = liveDeauthorizationSchema.safeParse(event);
    if (!parsed.success) {
      return "bad_request";
    }
    signal.throwIfAborted();
    await set(writeDb$)
      .update(connectors)
      .set({
        needsReconnect: true,
        reconnectReason: "authorization_expired_or_revoked",
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(connectors.connectorSlug, "stripe"),
          eq(connectors.authMethod, "oauth"),
          eq(connectors.externalId, parsed.data.account),
        ),
      );
    signal.throwIfAborted();
    return "ok";
  },
);
