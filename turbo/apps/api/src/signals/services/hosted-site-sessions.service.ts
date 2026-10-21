import { createHash, randomBytes } from "node:crypto";
import { command } from "ccstate";
import { and, eq, gt } from "drizzle-orm";
import { hostedSiteBrowserSessions } from "@okouai/db/schema/hosted-site-browser-session";
import {
  HOSTED_SITE_AUTH_CALLBACK_PATH,
  hostedSiteSessionTokenSchema,
} from "@okouai/api-contracts/contracts/hosted-site-access";
import { env } from "../../lib/env";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { db$, writeDb$ } from "../external/db";
import {
  authenticateClerkSession,
  clerk$,
  isClerkResourceNotFound,
} from "../external/clerk";
import { settle } from "../utils";
import {
  checkHostedSiteAccess$,
  readHostedSitePolicy$,
} from "./hosted-site-access.service";
import { hostedSiteSessionOrigin$ } from "./hosted-site-session-origin.service";

const CODE_LIFETIME_MS = 2 * 60 * 1000;
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function supportedOrigin(origin: string) {
  const url = new URL(origin);
  const sample = new URL(hostedLinkOrigin("current", "site"));
  const suffix = sample.hostname.slice("site".length);
  const label = url.hostname.endsWith(suffix)
    ? url.hostname.slice(0, -suffix.length)
    : "";
  return (
    url.origin === origin &&
    url.protocol === sample.protocol &&
    url.port === sample.port &&
    /^[a-z0-9][a-z0-9-]*$/u.test(label)
  );
}

const liveSession$ = command(
  async (
    { get },
    identity: { readonly userId: string; readonly clerkSessionId: string },
    signal: AbortSignal,
  ) => {
    const read = await settle(
      get(clerk$).sessions.getSession(
        identity.clerkSessionId,
        undefined,
        signal,
      ),
      signal,
    );
    if (!read.ok) {
      if (isClerkResourceNotFound(read.error)) {
        return false;
      }
      throw read.error;
    }
    return (
      read.value.id === identity.clerkSessionId &&
      read.value.userId === identity.userId &&
      read.value.status === "active" &&
      read.value.expireAt > nowDate().getTime()
    );
  },
);

export const authorizeHostedSiteSession$ = command(
  async (
    { get, set },
    args: {
      readonly siteId: string;
      readonly origin: string;
      readonly codeChallenge: string;
      readonly state: string;
    },
    signal: AbortSignal,
  ) => {
    if (!supportedOrigin(args.origin)) {
      return { status: "denied" as const };
    }
    const policy = await set(readHostedSitePolicy$, args.siteId, signal);
    if (
      !policy ||
      policy.site.linkLayoutSegment !== "okou" ||
      (policy.revision === null &&
        (env("HOSTED_SITE_ACCESS_ENABLED") !== "true" ||
          !env("HOSTED_SITE_VISIBILITY_SITE_IDS").includes(args.siteId)))
    ) {
      return { status: "denied" as const };
    }
    const suffix = new URL(hostedLinkOrigin("current", "site")).hostname.slice(
      4,
    );
    if (
      !(await set(
        hostedSiteSessionOrigin$,
        {
          siteId: args.siteId,
          publicSlug: policy.site.publicSlug,
          label: new URL(args.origin).hostname.slice(0, -suffix.length),
        },
        signal,
      ))
    ) {
      return { status: "denied" as const };
    }
    const request = get(request$).raw;
    const authorization = request.headers.get("Authorization");
    // The bridge accepts only a real session issued to the trusted App. Run
    // tokens, caller-supplied identities and hosted-origin Clerk JWTs cannot mint sessions.
    const auth = await authenticateClerkSession(
      new Request(request.url, {
        headers: authorization ? { Authorization: authorization } : {},
        signal,
      }),
      { authorizedParties: [new URL(env("APP_URL")).origin] },
    );
    signal.throwIfAborted();
    const identity = auth.identity;
    if (!identity?.sessionId) {
      return { status: "unauthenticated" as const };
    }
    if (
      !(await set(
        liveSession$,
        { userId: identity.userId, clerkSessionId: identity.sessionId },
        signal,
      ))
    ) {
      return { status: "unauthenticated" as const };
    }
    const access = await set(
      checkHostedSiteAccess$,
      { siteId: args.siteId, userId: identity.userId },
      signal,
    );
    if (!access.allowed) {
      return { status: "denied" as const };
    }
    const code = randomBytes(32).toString("hex");
    await set(writeDb$)
      .insert(hostedSiteBrowserSessions)
      .values({
        siteId: args.siteId,
        origin: args.origin,
        userId: identity.userId,
        clerkSessionId: identity.sessionId,
        codeHash: hash(code),
        codeChallenge: args.codeChallenge,
        expiresAt: new Date(nowDate().getTime() + CODE_LIFETIME_MS),
      });
    signal.throwIfAborted();
    const callback = new URL(HOSTED_SITE_AUTH_CALLBACK_PATH, args.origin);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", args.state);
    return { status: "ok" as const, callbackUrl: callback.href };
  },
);

export const exchangeHostedSiteSession$ = command(
  async (
    { get, set },
    args: {
      readonly siteId: string;
      readonly origin: string;
      readonly code: string;
      readonly codeVerifier: string;
    },
    signal: AbortSignal,
  ) => {
    const condition = and(
      eq(hostedSiteBrowserSessions.siteId, args.siteId),
      eq(hostedSiteBrowserSessions.origin, args.origin),
      eq(hostedSiteBrowserSessions.codeHash, hash(args.code)),
      eq(
        hostedSiteBrowserSessions.codeChallenge,
        createHash("sha256").update(args.codeVerifier).digest("base64url"),
      ),
      gt(hostedSiteBrowserSessions.expiresAt, nowDate()),
    );
    const [pending] = await get(db$)
      .select()
      .from(hostedSiteBrowserSessions)
      .where(condition)
      .limit(1);
    signal.throwIfAborted();
    if (!pending || !(await set(liveSession$, pending, signal))) {
      return null;
    }
    const sessionToken = `okou_site_${randomBytes(32).toString("hex")}`;
    const expiresAt = new Date(nowDate().getTime() + SESSION_LIFETIME_MS);
    // One atomic transition consumes the code; concurrent or replayed exchanges lose.
    const [session] = await set(writeDb$)
      .update(hostedSiteBrowserSessions)
      .set({
        codeHash: null,
        codeChallenge: null,
        tokenHash: hash(sessionToken),
        expiresAt,
      })
      .where(and(condition, gt(hostedSiteBrowserSessions.expiresAt, nowDate())))
      .returning({ id: hostedSiteBrowserSessions.id });
    signal.throwIfAborted();
    return session
      ? { sessionToken, expiresAt: expiresAt.toISOString() }
      : null;
  },
);

export const hostedSiteSessionViewer$ = command(
  async (
    { get, set },
    args: { readonly siteId: string; readonly origin: string },
    signal: AbortSignal,
  ) => {
    const authorization = get(request$).header("Authorization");
    const token = hostedSiteSessionTokenSchema.safeParse(
      authorization?.startsWith("Bearer ") ? authorization.slice(7) : null,
    );
    if (!token.success || !supportedOrigin(args.origin)) {
      return undefined;
    }
    const [session] = await get(db$)
      .select()
      .from(hostedSiteBrowserSessions)
      .where(
        and(
          eq(hostedSiteBrowserSessions.siteId, args.siteId),
          eq(hostedSiteBrowserSessions.origin, args.origin),
          eq(hostedSiteBrowserSessions.tokenHash, hash(token.data)),
          gt(hostedSiteBrowserSessions.expiresAt, nowDate()),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return session &&
      (await set(liveSession$, session, signal)) &&
      session.expiresAt.getTime() > nowDate().getTime()
      ? session.userId
      : undefined;
  },
);
