import { command } from "ccstate";
import { transcribeContract } from "@okouai/api-contracts/contracts/transcribe";
import {
  organizationAuthContext$,
  requiredAuthContext$,
} from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { badRequestMessage, notFound } from "../../lib/error";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { transcribeClips$ } from "../services/voice-transcription.service";

import { resolveVoiceClips$ } from "../services/voice-clips.service";
import { resolveArtifactPreviewUrl$ } from "../services/artifact-preview-url.service";
import { nowDate } from "../../lib/time";

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
const playback$ = authRoute(
  {
    requireOrganization: true,
    oauthScope: "okou:chat:read",
    accept: ["oauth"],
  },
  command(async ({ get, set }, signal: AbortSignal) => {
    const { orgId, userId } = get(organizationAuthContext$);
    const { fileId } = get(pathParamsOf(transcribeContract.playback));
    set(setResHeader$, "Cache-Control", "private, no-store");
    set(setResHeader$, "Referrer-Policy", "no-referrer");
    const resolved = await set(
      resolveVoiceClips$,
      { orgId, userId, fileIds: [fileId] },
      signal,
    );
    if ("status" in resolved) {
      return resolved;
    }
    const [clip] = resolved.clips;
    if (!clip) {
      return notFound("Voice clip unavailable");
    }
    if (clip.mimeType !== "audio/wav") {
      return badRequestMessage("Only WAV playback is supported");
    }
    const { url } = await set(
      resolveArtifactPreviewUrl$,
      { bucket: clip.bucket, key: clip.key, signingDate: nowDate() },
      signal,
    );
    return { status: 200 as const, body: { url } };
  }),
);

export const transcribeRoutes: readonly RouteEntry[] = [
  { route: transcribeContract.playback, handler: playback$ },
  {
    route: transcribeContract.transcribe,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      transcribe$,
    ),
  },
];
