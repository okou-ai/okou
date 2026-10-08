import { notionWebhookSecrets } from "@okouai/db/schema/notion-event";

import { db } from "../lib/db";

/**
 * Constructs the "Notion webhook not yet verified" Given by removing all
 * stored verification secrets.
 *
 * Why product APIs cannot construct this state: the Notion verification
 * handshake is a global one-shot — once any verification token is active,
 * `POST /api/webhooks/notion` rejects every further verification attempt
 * (401), so on the shared persistent test database the pre-verification
 * state is unreachable after the first test run that ever verified.
 */
export async function resetNotionWebhookVerification(): Promise<void> {
  await db().delete(notionWebhookSecrets);
}
