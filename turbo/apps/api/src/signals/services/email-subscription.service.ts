import type { EmailSubscriptionResponse } from "@okouai/api-contracts/contracts/email-subscription";
import { emailSuppressions } from "@okouai/db/schema/email-suppression";
import { users } from "@okouai/db/schema/user";
import { command } from "ccstate";
import { eq, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { getUserEmail$ } from "./email-common.service";

export const emailSubscription$ = command(
  async (
    { get, set },
    userId: string,
    signal: AbortSignal,
  ): Promise<EmailSubscriptionResponse> => {
    const db = get(db$);
    const email = await set(getUserEmail$, userId, signal);
    signal.throwIfAborted();
    const [user] = await db
      .select({ emailUnsubscribed: users.emailUnsubscribed })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    signal.throwIfAborted();
    // Users without an opt-out row already receive optional emails.
    const subscribed = !user?.emailUnsubscribed;
    if (!email) {
      return { subscribed, email: null, deliveryStatus: "no-email" };
    }
    const [suppression] = await db
      .select({ id: emailSuppressions.id })
      .from(emailSuppressions)
      .where(
        eq(sql`lower(${emailSuppressions.emailAddress})`, email.toLowerCase()),
      )
      .limit(1);
    signal.throwIfAborted();
    return {
      subscribed,
      email,
      deliveryStatus: suppression ? "suppressed" : "available",
    };
  },
);

export const updateEmailSubscription$ = command(
  async ({ set }, userId: string, subscribed: boolean, signal: AbortSignal) => {
    await set(writeDb$)
      .insert(users)
      .values({ id: userId, emailUnsubscribed: !subscribed })
      .onConflictDoUpdate({
        target: users.id,
        set: { emailUnsubscribed: !subscribed, updatedAt: nowDate() },
      });
    signal.throwIfAborted();
    return { subscribed };
  },
);
