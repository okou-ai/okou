import { voiceIoSpeechContract } from "@okouai/api-contracts/contracts/voice-io-speech";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import { retiredBuiltInGeneration$ } from "./retired-built-in-generation";

export const voiceIoSpeechRoutes: readonly RouteEntry[] = [
  {
    route: voiceIoSpeechContract.postPrivate,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      retiredBuiltInGeneration$,
    ),
  },
  {
    route: voiceIoSpeechContract.post,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      retiredBuiltInGeneration$,
    ),
  },
];
