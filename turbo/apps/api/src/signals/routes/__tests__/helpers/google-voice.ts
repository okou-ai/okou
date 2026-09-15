import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { stubTestVercelRuntimeToken } from "../../../../__tests__/env-stub";

import { mockOptionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";

export const VERTEX_VOICE_URL =
  /^https:\/\/(?:us-west1-aiplatform|aiplatform\.us\.rep)\.googleapis\.com\/v1\/projects\/[^/]+\/locations\/(?:us|us-west1)\/publishers\/google\/models\/gemini-[^/:]+:generateContent$/u;
export const GOOGLE_STS_URL =
  "https://sts.us-west1.rep.googleapis.com/v1/token";
export const GOOGLE_IMPERSONATION_URL =
  /^https:\/\/iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/[^/]+:generateAccessToken$/u;
export const GOOGLE_VOICE_PROVIDER =
  "projects/123456789/locations/global/workloadIdentityPools/vercel-api/providers/vercel";

export interface VertexVoiceRequest {
  readonly systemInstruction: {
    readonly parts: readonly { readonly text: string }[];
  };
  readonly contents: readonly {
    readonly role: string;
    readonly parts: readonly {
      readonly text?: string;
      readonly inlineData?: {
        readonly mimeType: string;
        readonly data: string;
      };
    }[];
  }[];
  readonly generationConfig: {
    readonly thinkingConfig: {
      readonly thinkingBudget?: number;
      readonly thinkingLevel?: string;
    };
    readonly maxOutputTokens: number;
    readonly temperature?: number;
    readonly responseMimeType?: string;
    readonly responseSchema?: { readonly required: readonly string[] };
  };
}

export function vertexVoiceResponse(text: string) {
  return HttpResponse.json({
    candidates: [
      { finishReason: "STOP", content: { role: "model", parts: [{ text }] } },
    ],
  });
}

/** Synthetic HTTP identity, isolated per test without resetting production caches. */
export function mockGoogleVoice() {
  const project = `voice-${randomUUID().slice(0, 18)}`;
  const serviceAccount = `llm-dev@${project}.iam.gserviceaccount.com`;
  mockOptionalEnv("GCP_LLM_PROJECT_ID", project);
  mockOptionalEnv("GCP_LLM_WORKLOAD_IDENTITY_PROVIDER", GOOGLE_VOICE_PROVIDER);
  mockOptionalEnv("GCP_LLM_SERVICE_ACCOUNT_EMAIL", serviceAccount);
  stubTestVercelRuntimeToken("synthetic-vercel-runtime-token");
  server.use(
    http.post(GOOGLE_STS_URL, () => {
      return HttpResponse.json({
        access_token: "synthetic-sts-token",
        token_type: "Bearer",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        expires_in: 3600,
      });
    }),
    http.post(GOOGLE_IMPERSONATION_URL, () => {
      return HttpResponse.json({
        accessToken: "synthetic-google-token",
        expireTime: new Date(now() + 3_599_000).toISOString(),
      });
    }),
  );
  return { project, serviceAccount };
}
