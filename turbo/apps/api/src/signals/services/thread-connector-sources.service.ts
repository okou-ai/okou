import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatThreadConnectorAccessOverrides } from "@okouai/db/schema/chat-thread-connector-access";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { computed, type Computed } from "ccstate";
import { and, asc, eq } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { array, unknown as zUnknown } from "zod";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import {
  contextJsonProjection,
  contextJsonRows,
  contextProjectionSchema,
} from "./context-rowset";

interface ThreadConnectorIdentity {
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string;
}

const selectionColumns = Object.freeze({
  connectorId: chatThreadConnectorSelections.connectorId,
  connectorSlug: chatThreadConnectorSelections.connectorSlug,
  customConnectorId: chatThreadConnectorSelections.customConnectorId,
});
const accessColumns = Object.freeze({
  connectorId: chatThreadConnectorAccessOverrides.connectorId,
  enabled: chatThreadConnectorAccessOverrides.enabled,
});

/** First coherent Thread preferences; no picked input or feature wait is needed. */
export function createThreadConnectorSources(
  identity$: Computed<Promise<ThreadConnectorIdentity | null>>,
) {
  return computed(async (get) => {
    const identity = await get(identity$);
    if (!identity) {
      return null;
    }
    const builder = new QueryBuilder();
    const selections = builder
      .select({
        payload: contextJsonProjection(selectionColumns)
          .mapWith(zodDriverValueDecoder(zUnknown()))
          .as("payload"),
      })
      .from(chatThreadConnectorSelections)
      .where(
        eq(chatThreadConnectorSelections.chatThreadId, identity.chatThreadId),
      )
      .orderBy(
        asc(chatThreadConnectorSelections.connectorSlug),
        asc(chatThreadConnectorSelections.customConnectorId),
      );
    const access = builder
      .select({
        payload: contextJsonProjection(accessColumns)
          .mapWith(zodDriverValueDecoder(zUnknown()))
          .as("payload"),
      })
      .from(chatThreadConnectorAccessOverrides)
      .where(
        eq(
          chatThreadConnectorAccessOverrides.chatThreadId,
          identity.chatThreadId,
        ),
      );
    const [row] = await get(db$)
      .select({
        selections: contextJsonRows(selections).mapWith(
          zodDriverValueDecoder(
            array(contextProjectionSchema(selectionColumns)),
          ),
        ),
        accessOverrides: contextJsonRows(access).mapWith(
          zodDriverValueDecoder(array(contextProjectionSchema(accessColumns))),
        ),
      })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, identity.chatThreadId),
          eq(chatThreads.userId, identity.userId),
          eq(chatThreads.orgId, identity.orgId),
        ),
      )
      .limit(1);
    return row ? { identity, ...row } : null;
  });
}
