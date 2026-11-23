import { presentationFormatContract } from "@okouai/api-contracts/contracts/presentation-format";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import {
  presentationFormatEnabled,
  userPresentationFormat,
} from "../services/user-data.service";

const getPresentationFormat$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "no-store");
    const auth = get(organizationAuthContext$);
    if (!(await get(presentationFormatEnabled(auth)))) {
      return {
        status: 403 as const,
        body: {
          error: {
            code: "FORBIDDEN",
            message: "Presentation output format is disabled",
          },
        },
      };
    }
    signal.throwIfAborted();
    const presentationFormat = await get(userPresentationFormat(auth));
    signal.throwIfAborted();
    return { status: 200 as const, body: { presentationFormat } };
  },
);

export const presentationFormatRoutes: readonly RouteEntry[] = [
  {
    route: presentationFormatContract.get,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "presentation-format:read",
      },
      getPresentationFormat$,
    ),
  },
];
