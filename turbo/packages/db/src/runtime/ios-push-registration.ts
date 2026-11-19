import { pgTable } from "drizzle-orm/pg-core";
import { iosPushRegistrationColumns } from "../columns/ios-push-registration";

/** Application mapping that tolerates removal of the retired widget columns. */
export const iosPushRegistrations = pgTable(
  "ios_push_registrations",
  iosPushRegistrationColumns(),
);
