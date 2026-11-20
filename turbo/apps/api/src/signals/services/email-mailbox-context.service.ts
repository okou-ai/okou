import { computed, type Computed } from "ccstate";
import type { EmailMailboxConnection } from "./email-prompt";
import type { ConnectedAccounts } from "./thread-connected-accounts.signals";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

/** Describe only the mailbox accounts already selected for this Run. */
export function createEmailMailboxConnections(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  accounts$: ConnectedAccounts["selectedStoredConnectorAccounts$"],
): Computed<Promise<readonly EmailMailboxConnection[]>> {
  return computed(async (get) => {
    const event = await get(pickedEvent$);
    if (event?.contextType !== "email") {
      return [];
    }
    const accounts = await get(accounts$);
    return accounts
      .flatMap<EmailMailboxConnection>((account) => {
        const { connectorSlug } = account;
        if (
          account.userId !== event.userId ||
          account.needsReconnect ||
          (connectorSlug !== "gmail" && connectorSlug !== "outlook-mail")
        ) {
          return [];
        }
        return [
          {
            connectorSlug,
            connectionId: account.connectorId,
            emailAddress: account.externalEmail,
            displayName: account.displayName,
          },
        ];
      })
      .sort((left, right) => {
        return left.connectorSlug.localeCompare(right.connectorSlug);
      });
  });
}
