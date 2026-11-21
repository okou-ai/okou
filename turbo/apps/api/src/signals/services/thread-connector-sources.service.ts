import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatThreadConnectorAccessOverrides } from "@okouai/db/schema/chat-thread-connector-access";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { and, asc, eq, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { array, object, unknown as zUnknown } from "zod";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
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

const threadSourcesDecoder = zodDriverValueDecoder(
  object({
    selections: array(contextProjectionSchema(selectionColumns)),
    accessOverrides: array(contextProjectionSchema(accessColumns)),
  }).nullable(),
);

export function threadConnectorSourcesColumn(
  identity: ThreadConnectorIdentity,
  newThread: boolean,
) {
  if (newThread) {
    // First-message publication must create the Thread to use this context.
    // That insert starts with no saved selections or access overrides.
    return sql`'{"selections":[],"accessOverrides":[]}'::jsonb`.mapWith(
      threadSourcesDecoder,
    );
  }
  const { chatThreadId } = identity;
  const builder = new QueryBuilder();
  const selections = builder
    .select({
      payload: contextJsonProjection(selectionColumns)
        .mapWith(zodDriverValueDecoder(zUnknown()))
        .as("payload"),
    })
    .from(chatThreadConnectorSelections)
    .where(eq(chatThreadConnectorSelections.chatThreadId, chatThreadId))
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
    .where(eq(chatThreadConnectorAccessOverrides.chatThreadId, chatThreadId));
  const statement = builder
    .select({
      payload: sql`jsonb_build_object(
        'selections', ${contextJsonRows(selections)},
        'accessOverrides', ${contextJsonRows(access)}
      )`.mapWith(threadSourcesDecoder),
    })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, chatThreadId),
        eq(chatThreads.userId, identity.userId),
        eq(chatThreads.orgId, identity.orgId),
      ),
    )
    .limit(1);
  return sql`(${statement})`.mapWith(threadSourcesDecoder);
}
