import { command } from "ccstate";
import { transcribeContract } from "@okouai/api-contracts/contracts/transcribe";
import {
  organizationAuthContext$,
  requiredAuthContext$,
} from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { transcribeClips$ } from "../services/voice-transcription.service";

const body$ = bodyResultOf(transcribeContract.transcribe);
const transcribe$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType === "agent" || auth.tokenType === "sandbox") {
    const read = await set(
      requiredAuthContext$,
      { requireOrganization: true, requiredCapability: "file:read" },
      signal,
    );
    if ("status" in read) {
      return read;
    }
  }
  const parsed = await get(body$);
  signal.throwIfAborted();
  if (!parsed.ok) {
    return parsed.response;
  }
  return await set(
    transcribeClips$,
    {
      ...parsed.data,
      orgId: auth.orgId,
      userId: auth.userId,
      runId:
        auth.tokenType === "sandbox" || auth.tokenType === "agent"
          ? auth.runId
          : undefined,
    },
    signal,
  );
});
export const transcribeRoutes: readonly RouteEntry[] = [
  {
    route: transcribeContract.transcribe,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      transcribe$,
    ),
  },
];
