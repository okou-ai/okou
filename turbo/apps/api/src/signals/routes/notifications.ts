import { notificationsContract } from "@okouai/api-contracts/contracts/notifications";
import { command } from "ccstate";
import { resourceUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  mailNotification,
  mailNotificationsEnabled,
  queueMailNotification$,
} from "../services/mail-notification.service";

const mailBody$ = bodyResultOf(notificationsContract.mail);
const getParams$ = pathParamsOf(notificationsContract.get);
const disabled = () => {
  return resourceUnavailable(
    "Mail notifications are disabled. Enable notifyMail and start a new run to obtain notify:write.",
  );
};
const mail$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    return resourceUnavailable("Mail notifications require an Okou run token.");
  }
  const enabled = await get(mailNotificationsEnabled(auth));
  signal.throwIfAborted();
  if (!enabled) {
    return disabled();
  }
  const body = await get(mailBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return await set(queueMailNotification$, auth, body.data, signal);
});
const get$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const enabled = await get(mailNotificationsEnabled(auth));
  signal.throwIfAborted();
  if (!enabled) {
    return disabled();
  }
  const result = await get(mailNotification(auth, get(getParams$).id));
  signal.throwIfAborted();
  return result;
});

export const notificationsRoutes: readonly RouteEntry[] = [
  {
    route: notificationsContract.mail,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        requiredCapability: "notify:write",
      },
      mail$,
    ),
  },
  {
    route: notificationsContract.get,
    handler: authRoute(
      {
        accept: ["agent", "session", "pat"],
        requireOrganization: true,
        requiredCapability: "notify:write",
      },
      get$,
    ),
  },
];
