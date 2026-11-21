import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { eq, type SQL } from "drizzle-orm";

export function chatThreadOrganizationCondition(orgId: string): SQL {
  return chatThreadOrganizationPredicate(orgId);
}

export function chatThreadOrganizationPredicate(orgId: string): SQL {
  return eq(chatThreads.orgId, orgId);
}
