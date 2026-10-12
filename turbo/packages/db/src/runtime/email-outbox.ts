import { pgTable } from "drizzle-orm/pg-core";
import { emailOutboxColumns } from "../columns/email-outbox";

// Application mapping. It omits the retired completion-email source pair, which
// stays migration-owned until release 3 of #39378 drops it after outgoing APIs
// drain and rollback excludes them. DDL lives in the schema.
export const emailOutbox = pgTable("email_outbox", emailOutboxColumns());
