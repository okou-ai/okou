import { pgTable } from "drizzle-orm/pg-core";
import { emailOutboxColumns } from "../columns/email-outbox";

// Application mapping. DDL lives in the schema.
export const emailOutbox = pgTable("email_outbox", emailOutboxColumns());
