import { createAppWithRoutes } from "../app-factory-runtime";
import { createWorkerHandler } from "../worker-runtime";
import type { RouteEntry } from "../signals/route-entry";
import { cronDrainEmailOutboxRoutes } from "../signals/routes/cron-drain-email-outbox";
import { emailInboundRoutes } from "../signals/routes/email-inbound";
import { emailSubscriptionRoutes } from "../signals/routes/email-subscription";
import { halloweenRoutes } from "../signals/routes/halloween";
import { notificationsRoutes } from "../signals/routes/notifications";
import { initializeNoServices$ } from "./initialize-no-services";

const roleRoutes: readonly RouteEntry[] = [
  ...cronDrainEmailOutboxRoutes,
  ...emailInboundRoutes,
  ...emailSubscriptionRoutes,
  ...halloweenRoutes,
  ...notificationsRoutes,
];

export default createWorkerHandler((signal) => {
  return createAppWithRoutes({
    signal,
    routes: roleRoutes,
    initializeServices$: initializeNoServices$,
  });
});
