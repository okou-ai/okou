import { authContract } from "../contracts/auth";
import { computerUseSessionHostsContract } from "../contracts/computer-use";
import { desktopUpdatesContract } from "../contracts/desktop-updates";
import { featureSwitchesContract } from "../contracts/feature-switches";
import { orgContract } from "../contracts/org-routes";
import { platformRealtimeTokenContract } from "../contracts/realtime";

export interface SwiftRouteLike {
  readonly method?: unknown;
  readonly path?: unknown;
  readonly summary?: unknown;
}

export interface SwiftRouteBinding {
  readonly swiftName: string;
  readonly route: SwiftRouteLike;
}

/**
 * Routes the Desktop app calls. Rendered as static members of `ApiRoutes` in
 * `desktop/Okou/Core/Generated/ApiRoutes.swift`; routes with path parameters
 * become functions.
 */
export const swiftRouteBindings = [
  {
    swiftName: "computerUseHostRegister",
    route: computerUseSessionHostsContract.register,
  },
  {
    swiftName: "computerUseHostHeartbeat",
    route: computerUseSessionHostsContract.heartbeat,
  },
  {
    swiftName: "computerUseHostStop",
    route: computerUseSessionHostsContract.stop,
  },
  {
    swiftName: "computerUseHostCommandNext",
    route: computerUseSessionHostsContract.next,
  },
  {
    swiftName: "computerUseHostCommandComplete",
    route: computerUseSessionHostsContract.complete,
  },
  {
    swiftName: "desktopCompatibility",
    route: desktopUpdatesContract.compatibility,
  },
  {
    swiftName: "desktopProductDmgDownload",
    route: desktopUpdatesContract.productDmgDownload,
  },
  {
    swiftName: "platformRealtimeToken",
    route: platformRealtimeTokenContract.create,
  },
  { swiftName: "authMe", route: authContract.me },
  { swiftName: "org", route: orgContract.get },
  { swiftName: "featureSwitches", route: featureSwitchesContract.get },
] as const satisfies readonly SwiftRouteBinding[];
