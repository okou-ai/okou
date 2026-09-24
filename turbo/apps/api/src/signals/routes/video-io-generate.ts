import { videoIoGenerateContract } from "@okouai/api-contracts/contracts/video-io-generate";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import { retiredBuiltInGeneration$ } from "./retired-built-in-generation";

export const videoIoGenerateRoutes: readonly RouteEntry[] = [
  {
    route: videoIoGenerateContract.postPrivate,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      retiredBuiltInGeneration$,
    ),
  },
  {
    route: videoIoGenerateContract.post,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      retiredBuiltInGeneration$,
    ),
  },
];
