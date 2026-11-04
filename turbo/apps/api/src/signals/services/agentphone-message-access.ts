import { agentphoneMessages } from "@okouai/db/schema/agentphone-message";
import { agentphoneMessageVisibility } from "@okouai/db/schema/agentphone-message-visibility";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { and, arrayOverlaps, eq, inArray, sql } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";

/** The original roster grants access when its recipient connects, even later. */
export function agentPhoneMessageVisibleTo(identity: {
  readonly orgId: string;
  readonly userId: string;
}) {
  const query = new QueryBuilder();
  const verifiedHandles = query
    .select({ phoneHandle: agentphoneUserLinks.phoneHandle })
    .from(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.orgId, identity.orgId),
        eq(agentphoneUserLinks.userId, identity.userId),
      ),
    );
  // Pre-snapshot messages retain only the access already recorded for them.
  const accountGrants = query
    .select({ messageId: agentphoneMessageVisibility.messageId })
    .from(agentphoneMessageVisibility)
    .where(
      and(
        eq(agentphoneMessageVisibility.orgId, identity.orgId),
        eq(agentphoneMessageVisibility.userId, identity.userId),
      ),
    );
  const recipientMessages = alias(agentphoneMessages, "recipient_messages");
  const rosterGrants = query
    .select({ messageId: recipientMessages.id })
    .from(recipientMessages)
    .where(
      arrayOverlaps(
        recipientMessages.participantHandles,
        sql`ARRAY(${verifiedHandles})::text[]`,
      ),
    );
  // Separate grant sets keep both the account and roster indexes usable.
  return inArray(agentphoneMessages.id, accountGrants.unionAll(rosterGrants));
}
