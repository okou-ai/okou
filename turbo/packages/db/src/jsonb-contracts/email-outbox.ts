import type { JsonStringRecord, JsonValue } from "./shared";

export type EmailOutboxAddresses = string | readonly string[];
export type EmailOutboxHeaders = JsonStringRecord;
export type EmailOutboxTemplate = JsonValue;
/**
 * Immutable rendered provider request replayed by every delivery attempt of one
 * outbox row. The sender validates its exact shape at read time.
 */
export type EmailOutboxProviderRequest = JsonValue;
