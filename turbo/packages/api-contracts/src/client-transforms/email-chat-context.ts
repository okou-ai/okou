import { chatThreadEventsContract } from "../contracts/chat-threads";
import type { ChatEventRow } from "../contracts/chat-event-rows";
import type { ClientResponseTransform } from "./types";

/** Installed native readers display the payload without an Email context reader. */
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
