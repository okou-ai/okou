import { computed, type Computed } from "ccstate";
import type { BootstrapConnectorAccount } from "./agent-run-context.signals";
import type { ConnectorSourceResult } from "./execution-connector-sources.service";
import type { EmailMailboxConnection } from "./email-prompt";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

/** Describe only the mailbox accounts already selected for this Run. */
export function createEmailMailboxConnections(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  selectedSources$: Computed<Promise<readonly ConnectorSourceResult[]>>,
  connectorAccounts$: Computed<Promise<readonly BootstrapConnectorAccount[]>>,
): Computed<Promise<readonly EmailMailboxConnection[]>> {
  return computed(async (get) => {
    const event = await get(pickedEvent$);
    if (event?.contextType !== "email") {
      return [];
    }
    const [sources, connectorAccounts] = await Promise.all([
      get(selectedSources$),
      get(connectorAccounts$),
    ]);
    const accounts = new Map(
      connectorAccounts.map((account) => {
        return [account.connectorId, account];
      }),
    );
    return sources
      .flatMap<EmailMailboxConnection>((result) => {
        if (result.kind !== "available") {
          return [];
        }
        const source = result.snapshot.source;
        if (
          source.kind !== "builtin" ||
          (source.connectorSlug !== "gmail" &&
            source.connectorSlug !== "outlook-mail")
        ) {
          return [];
        }
        const account = accounts.get(source.sourceId);
        return account?.userId === event.userId && !account.needsReconnect
          ? [
              {
                connectorSlug: source.connectorSlug,
                connectionId: source.sourceId,
                emailAddress: account.externalEmail,
                displayName: account.displayName,
              },
            ]
          : [];
      })
      .sort((left, right) => {
        return left.connectorSlug.localeCompare(right.connectorSlug);
      });
  });
}
