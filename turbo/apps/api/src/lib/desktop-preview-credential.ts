import { createHmac } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { authContract } from "@okouai/api-contracts/contracts/auth";
import { computerUseSessionHostsContract } from "@okouai/api-contracts/contracts/computer-use";
import { desktopUpdatesContract } from "@okouai/api-contracts/contracts/desktop-updates";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import { now, nowDate } from "./time";

export const DESKTOP_PREVIEW_HEADER = "x-okou-desktop-preview";
const ISSUER = "okou-desktop-preview";
const TYPE = "okou-desktop-preview+jwt";
const TTL_SECONDS = 15 * 60;
const PR_API_ORIGIN = /^https:\/\/pr-[1-9][0-9]*-api\.vm6\.ai$/u;
const routes = Object.freeze(
  [
    authContract.me,
    orgContract.get,
    featureSwitchesContract.get,
    desktopUpdatesContract.compatibility,
    platformRealtimeTokenContract.create,
    ...Object.values(computerUseSessionHostsContract),
  ].map((route) => {
    return route.method + " " + route.path;
  }),
);

function signingKey(previewSecret: string): Uint8Array {
  return createHmac("sha256", previewSecret).update(TYPE).digest();
}

/** Called by the operator's local QA tool. No HTTP endpoint issues these credentials. */
export async function issueDesktopPreviewCredential(
  origin: string,
  previewSecret: string,
) {
  if (!PR_API_ORIGIN.test(origin) || !previewSecret) {
    throw new Error(
      "A canonical PR API origin and preview signing secret are required",
    );
  }
  const issuedAt = Math.floor(now() / 1000);
  const expiresAt = issuedAt + TTL_SECONDS;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: TYPE })
    .setIssuer(ISSUER)
    .setAudience(origin)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(signingKey(previewSecret));
  return { origin, expiresAt, token };
}

export async function verifyDesktopPreviewCredential(
  token: string,
  request: Request,
  configuredOrigin: string | undefined,
  routeTemplate: string | undefined,
  previewSecret: string,
): Promise<boolean> {
  const origin = new URL(request.url).origin;
  if (
    token.length > 1024 ||
    !PR_API_ORIGIN.test(origin) ||
    origin !== configuredOrigin?.replace(/\/$/u, "") ||
    !routeTemplate ||
    !routes.includes(request.method + " " + routeTemplate)
  ) {
    return false;
  }
  const { payload } = await jwtVerify(token, signingKey(previewSecret), {
    algorithms: ["HS256"],
    typ: TYPE,
    issuer: ISSUER,
    audience: origin,
    requiredClaims: ["exp", "iat"],
    maxTokenAge: TTL_SECONDS,
    currentDate: nowDate(),
  });
  return payload.aud === origin;
}
