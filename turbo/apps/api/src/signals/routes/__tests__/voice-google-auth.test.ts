import { voiceIoPolishSegmentsContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { voiceIoPolishRoutes } from "../voice-io-polish";
import { createBddApi } from "./helpers/api-bdd";
import {
  GOOGLE_IMPERSONATION_URL,
  GOOGLE_STS_URL,
  GOOGLE_VOICE_PROVIDER,
  VERTEX_VOICE_URL,
  mockGoogleLlm,
  vertexVoiceResponse,
} from "./helpers/google-voice";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const polish = setupApp({ context, routes: voiceIoPolishRoutes })(
  voiceIoPolishSegmentsContract,
);

/** A workspace admin who completed onboarding, signed in for the next call. */
async function onboardedAdmin() {
  const admin = bdd.user();
  await bdd.bootstrapLimitedFreeOnboarding(admin);
  return () => {
    createRouteMocks(context).clerk.session(admin.userId, admin.orgId);
    return { authorization: "Bearer clerk-session" };
  };
}

interface GoogleReceipts {
  readonly sts: {
    readonly authorization: string | null;
    readonly form: URLSearchParams;
  }[];
  readonly impersonation: {
    readonly url: string;
    readonly authorization: string | null;
    readonly body: unknown;
  }[];
  readonly vertex: (string | null)[];
}

/**
 * Google answers STS and Vertex normally; impersonation answers with the
 * given statuses in order, then succeeds.
 */
function mockGoogleExchange(impersonationFailures: readonly number[] = []) {
  const identity = mockGoogleLlm();
  const receipts: GoogleReceipts = { sts: [], impersonation: [], vertex: [] };
  const failures = [...impersonationFailures];
  server.use(
    http.post(GOOGLE_STS_URL, async ({ request }) => {
      receipts.sts.push({
        authorization: request.headers.get("authorization"),
        form: new URLSearchParams(await request.text()),
      });
      return HttpResponse.json({
        access_token: "synthetic-sts-token",
        token_type: "Bearer",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        expires_in: 3600,
      });
    }),
    http.post(GOOGLE_IMPERSONATION_URL, async ({ request }) => {
      receipts.impersonation.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      const failure = failures.shift();
      if (failure !== undefined) {
        return HttpResponse.json(
          { error: { message: "private-impersonation-detail" } },
          { status: failure },
        );
      }
      return HttpResponse.json({
        accessToken: "impersonated-token",
        expireTime: new Date(now() + 3_599_000).toISOString(),
      });
    }),
    http.post(VERTEX_VOICE_URL, ({ request }) => {
      receipts.vertex.push(request.headers.get("authorization"));
      return vertexVoiceResponse("Synthetic dictation.");
    }),
  );
  return { ...identity, receipts };
}

async function polishOnce(headers: { readonly authorization: string }) {
  return await accept(
    polish.post({ headers, body: { segments: ["Synthetic dictation."] } }),
    [200, 502],
  );
}

describe("Google voice workload identity through the public API", () => {
  it("voice-google-auth-009 rejects a missing GCP_LLM_PROJECT_ID before any Google request", async () => {
    const signIn = await onboardedAdmin();
    mockGoogleLlm();
    mockOptionalEnv("GCP_LLM_PROJECT_ID", undefined);
    const googleRequests: string[] = [];
    server.use(
      http.all(/^https:\/\/[^/]*googleapis\.com\//u, ({ request }) => {
        googleRequests.push(request.url);
        return HttpResponse.json({}, { status: 500 });
      }),
    );

    const response = await accept(
      polish.post({
        headers: signIn(),
        body: { segments: ["Synthetic dictation."] },
      }),
      [503],
    );

    expect(response.body.error.code).toBe("NOT_CONFIGURED");
    expect(googleRequests).toStrictEqual([]);
  });

  it("voice-google-auth-007 exchanges the Vercel identity once, impersonates the exact account and reuses the credential", async () => {
    const signIn = await onboardedAdmin();
    const { serviceAccount, receipts } = mockGoogleExchange();

    const first = await polishOnce(signIn());
    const second = await polishOnce(signIn());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(receipts.sts).toHaveLength(1);
    expect(receipts.sts[0]?.authorization).toBeNull();
    expect(Object.fromEntries(receipts.sts[0]?.form ?? [])).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: `//iam.googleapis.com/${GOOGLE_VOICE_PROVIDER}`,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token: "synthetic-vercel-runtime-token",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    });
    expect(receipts.impersonation).toStrictEqual([
      {
        url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`,
        authorization: "Bearer synthetic-sts-token",
        body: {
          scope: ["https://www.googleapis.com/auth/cloud-platform"],
          lifetime: "3600s",
        },
      },
    ]);
    expect(receipts.vertex).toStrictEqual([
      "Bearer impersonated-token",
      "Bearer impersonated-token",
    ]);
  });

  it("voice-google-auth-029 does not retry a denied impersonation and lets a later request recover", async () => {
    const signIn = await onboardedAdmin();
    const { receipts } = mockGoogleExchange([403]);

    const denied = await polishOnce(signIn());
    expect(denied.status).toBe(502);
    expect(JSON.stringify(denied.body)).not.toContain(
      "private-impersonation-detail",
    );
    expect(receipts.impersonation).toHaveLength(1);

    const recovered = await polishOnce(signIn());
    expect(recovered.status).toBe(200);
    expect(receipts.impersonation).toHaveLength(2);
  });
});
