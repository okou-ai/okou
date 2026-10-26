import type { ZodType } from "zod";
import { authContract } from "../contracts/auth";
import { computerUseSessionHostsContract } from "../contracts/computer-use";
import {
  desktopUpdatesContract,
  desktopUpgradeRequiredSchema,
} from "../contracts/desktop-updates";
import { apiErrorSchema } from "../contracts/errors";
import { featureSwitchesResponseSchema } from "../contracts/feature-switches";
import { orgResponseSchema } from "../contracts/orgs";

export interface SwiftTypeBinding {
  readonly schema: ZodType;
  readonly swiftTypeName: string;
  readonly doc: readonly string[];
}

/**
 * Response bodies the Desktop app decodes. Request bodies, command results,
 * and the realtime token stay `JSONValue` because the native helper or Ably,
 * not the app, authors or consumes them.
 */
export const swiftTypeBindings = [
  {
    schema: computerUseSessionHostsContract.register.responses[200],
    swiftTypeName: "ComputerUseHostRegistration",
    doc: ["`POST /api/computer-use/hosts/register` success body."],
  },
  {
    schema: computerUseSessionHostsContract.heartbeat.responses[200],
    swiftTypeName: "ComputerUseHostHeartbeat",
    doc: ["`POST /api/computer-use/hosts/:hostId/heartbeat` success body."],
  },
  {
    schema: computerUseSessionHostsContract.next.responses[200],
    swiftTypeName: "ComputerUseCommandClaim",
    doc: [
      "`POST /api/computer-use/hosts/:hostId/commands/next` success body: an",
      "idle queue or one claimed command.",
    ],
  },
  {
    schema: desktopUpgradeRequiredSchema,
    swiftTypeName: "DesktopUpgradeRequired",
    doc: ["`426` body of the Desktop-gated Computer Use routes."],
  },
  {
    schema: desktopUpdatesContract.compatibility.responses[200],
    swiftTypeName: "DesktopCompatibilityPolicy",
    doc: [
      "`GET /api/desktop/compatibility` body. A `null` floor disables enforcement.",
    ],
  },
  {
    schema: authContract.me.responses[200],
    swiftTypeName: "AuthenticatedUser",
    doc: ["`GET /api/auth/me` success body."],
  },
  {
    schema: orgResponseSchema,
    swiftTypeName: "CurrentOrganization",
    doc: ["`GET /api/org` success body."],
  },
  {
    schema: featureSwitchesResponseSchema,
    swiftTypeName: "FeatureSwitches",
    doc: ["`GET /api/feature-switches` success body."],
  },
  {
    schema: apiErrorSchema,
    swiftTypeName: "ApiError",
    doc: ["Error envelope shared by every API error response."],
  },
] as const satisfies readonly SwiftTypeBinding[];
