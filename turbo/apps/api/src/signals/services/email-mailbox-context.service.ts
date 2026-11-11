import { computed, type Computed } from "ccstate";
import { and, asc, eq, inArray } from "drizzle-orm";
import { connectors } from "@okouai/db/schema/connector";
import { db$ } from "../external/db";
import type { ConnectorSourceResult } from "./execution-connector-sources.service";
import type { EmailMailboxConnection } from "./email-prompt";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

/** Describe only the mailbox accounts already selected for this Run. */
export function createEmailMailboxConnections(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  selectedSources$: Computed<Promise<readonly ConnectorSourceResult[]>>,
  orgId: string,
): Computed<Promise<readonly EmailMailboxConnection[]>> {
  return computed(async (get) => {
    const event = await get(pickedEvent$);
    if (event?.contextType !== "email") {
      return [];
    }
    const sources = await get(selectedSources$);
    const mailboxes = sources.flatMap<
      Pick<EmailMailboxConnection, "connectorSlug" | "connectionId">
    >((result) => {
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
      return [
        { connectorSlug: source.connectorSlug, connectionId: source.sourceId },
      ];
    });
    if (mailboxes.length === 0) {
      return [];
    }
    const rows = await get(db$)
      .select({
        connectionId: connectors.id,
        emailAddress: connectors.externalEmail,
        displayName: connectors.displayName,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, orgId),
          eq(connectors.userId, event.userId),
          eq(connectors.needsReconnect, false),
          inArray(
            connectors.id,
            mailboxes.map((mailbox) => {
              return mailbox.connectionId;
            }),
          ),
        ),
      )
      .orderBy(asc(connectors.connectorSlug), asc(connectors.id));
    return rows.flatMap((row) => {
      const mailbox = mailboxes.find((candidate) => {
        return candidate.connectionId === row.connectionId;
      });
      return mailbox ? [{ ...mailbox, ...row }] : [];
    });
  });
}
