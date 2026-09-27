/**
 * Chat Event rows, Snapshot NDJSON lines, and the browser row cache all use
 * this one schema version. Snapshot storage records the version it contains;
 * live PostgreSQL rows are always represented in the API's current version.
 */
export const CURRENT_CHAT_EVENT_SCHEMA_VERSION = 7 as const;

export type ChatEventCursor =
  | { readonly lastEventId: null; readonly lastSeqId: 0 }
  | {
      readonly lastEventId: string;
      readonly lastSeqId: number;
    };
