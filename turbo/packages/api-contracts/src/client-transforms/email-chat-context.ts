import { chatThreadEventsContract } from "../contracts/chat-threads";
import type { ChatEventRow } from "../contracts/chat-event-rows";
import type { ClientResponseTransform } from "./types";

/**
 * Installed iOS readers cannot decode Email context on the shared chat routes.
 * Bound these transforms when an Email-capable iOS release becomes available;
 * remove both entries and wiring when the enforced iOS floor excludes older
 * readers. Follow-up: #46063, using the native transform lifecycle.
 */
function legacyEmailContext(row: ChatEventRow): ChatEventRow {
  return row.contextType === "email"
    ? { ...row, contextType: "web", contextId: null }
    : row;
}

export const iosEmailChatRowsTransform: ClientResponseTransform = {
  client: "ios",
  method: chatThreadEventsContract.rows.method,
  path: chatThreadEventsContract.rows.path,
  status: 200,
  maxVersion: null,
  since: "#46081",
  transform: (body) => {
    const current = chatThreadEventsContract.rows.responses[200].parse(body);
    return { ...current, rows: current.rows.map(legacyEmailContext) };
  },
};

export const iosEmailChatCatchUpTransform: ClientResponseTransform = {
  client: "ios",
  method: chatThreadEventsContract.catchUp.method,
  path: chatThreadEventsContract.catchUp.path,
  status: 200,
  maxVersion: null,
  since: "#46081",
  transform: (body) => {
    const current = chatThreadEventsContract.catchUp.responses[200].parse(body);
    return {
      ...current,
      events: Object.fromEntries(
        Object.entries(current.events).map(([id, rows]) => {
          return [id, rows.map(legacyEmailContext)];
        }),
      ),
    };
  },
};
