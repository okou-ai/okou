import { command } from "ccstate";
import { iosPushRegistrationsContract } from "@okouai/api-contracts/contracts/ios-push-registrations";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  isActiveIosPushSession$,
  updateIosPushRegistration$,
} from "../services/ios-push-registrations.service";
import type { RouteEntry } from "../route-entry";

function updateRegistration(enabled: boolean) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    if (auth.tokenType !== "session" || !auth.sessionId) {
      return {
        status: 403 as const,
        body: {
          error: {
            code: "FORBIDDEN",
            message: "An active app session is required",
          },
        },
      };
    }
    const body = await get(
      bodyResultOf(
        enabled
          ? iosPushRegistrationsContract.register
          : iosPushRegistrationsContract.unregister,
      ),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    if (
      enabled &&
      !(await set(
        isActiveIosPushSession$,
        { userId: auth.userId, sessionId: auth.sessionId },
        signal,
      ))
    ) {
      return {
        status: 401 as const,
        body: {
          error: {
            code: "UNAUTHORIZED",
            message: "Session is no longer active",
          },
        },
      };
    }
    const updated = await set(
      updateIosPushRegistration$,
      {
        ...body.data,
        deviceToken: "deviceToken" in body.data ? body.data.deviceToken : "",
        environment:
          "environment" in body.data ? body.data.environment : "production",
        userId: auth.userId,
        sessionId: auth.sessionId,
        enabled,
      },
      signal,
    );
    signal.throwIfAborted();
    return updated
      ? { status: 200 as const, body: { success: true as const } }
      : {
          status: 409 as const,
          body: {
            error: {
              code: "CONFLICT",
              message: "A newer installation binding already exists",
            },
          },
        };
  });
}

export const iosPushRegistrationsRoutes: readonly RouteEntry[] = [
  {
    route: iosPushRegistrationsContract.register,
    handler: authRoute({}, updateRegistration(true)),
  },
  {
    route: iosPushRegistrationsContract.unregister,
    handler: authRoute({}, updateRegistration(false)),
  },
];
