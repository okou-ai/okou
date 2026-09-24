import { avatarVideoContract } from "@okouai/api-contracts/contracts/avatar-video";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import { retiredBuiltInGeneration$ } from "./retired-built-in-generation";

export const avatarVideoRoutes: readonly RouteEntry[] = [
  {
    route: avatarVideoContract.generatePrivate,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      retiredBuiltInGeneration$,
    ),
  },
  {
    route: avatarVideoContract.generate,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      retiredBuiltInGeneration$,
    ),
  },
  {
    route: avatarVideoContract.avatars,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      retiredBuiltInGeneration$,
    ),
  },
  {
    route: avatarVideoContract.voices,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      retiredBuiltInGeneration$,
    ),
  },
];
