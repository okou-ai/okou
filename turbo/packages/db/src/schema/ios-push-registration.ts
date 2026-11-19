import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { iosPushRegistrationColumns } from "../columns/ios-push-registration";

// Retain disabled bindings so an older in-flight register cannot undo sign-out.
export const iosPushRegistrations = pgTable(
  "ios_push_registrations",
  {
    ...iosPushRegistrationColumns(),
    // WidgetKit's token for this installation's widgets; null until a widget is installed.
    widgetPushToken: text("widget_push_token"),
    // The last widget push claimed for this binding; it spaces pushes to the device.
    widgetPushedAt: timestamp("widget_pushed_at"),
  },
  (table) => {
    return [index("idx_ios_push_registrations_user").on(table.userId)];
  },
);
