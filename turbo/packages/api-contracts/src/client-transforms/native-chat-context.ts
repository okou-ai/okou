import { chatThreadEventsContract } from "../contracts/chat-threads";
import type { ChatEventRow } from "../contracts/chat-event-rows";
import type { ClientResponseTransform } from "./types";

/** Retire the projections once the enforced native versions accept these contexts (#46063, #50929). */
function forClient(client: "ios" | "android") {
  const common = {
    client,
    maxVersion: null,
    since: client === "ios" ? "#46081" : "#51181",
  } as const;
  function legacyContext(row: ChatEventRow): ChatEventRow {
    if (
      row.contextType === "proactive" ||
      (client === "ios" && row.contextType === "email")
    ) {
      return { ...row, contextType: "web", contextId: null };
    }
    return row;
  }
  return {
    rows: {
      ...common,
      method: chatThreadEventsContract.rows.method,
      path: chatThreadEventsContract.rows.path,
      status: 200,
      transform(body) {
        const response =
          chatThreadEventsContract.rows.responses[200].parse(body);
        return { ...response, rows: response.rows.map(legacyContext) };
      },
    },
    catchUp: {
      ...common,
      method: chatThreadEventsContract.catchUp.method,
      path: chatThreadEventsContract.catchUp.path,
      status: 200,
      transform(body) {
        const response =
          chatThreadEventsContract.catchUp.responses[200].parse(body);
        return {
          ...response,
          events: Object.fromEntries(
            Object.entries(response.events).map(([id, rows]) => {
              return [id, rows.map(legacyContext)];
            }),
          ),
        };
      },
    },
  } satisfies Record<string, ClientResponseTransform>;
}

export const iosChatContextTransforms = forClient("ios");
export const androidChatContextTransforms = forClient("android");
