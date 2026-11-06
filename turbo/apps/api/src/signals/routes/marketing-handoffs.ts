import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { command } from "ccstate";
import {
  MARKETING_HANDOFF_MAX_FILE_BYTES,
  marketingHandoffsContract,
  serializeMarketingHandoff,
} from "@okouai/api-contracts/contracts/marketing-handoffs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import {
  badRequestMessage,
  notConfigured,
  notFound,
  resourceUnavailable,
} from "../../lib/error";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { normalizeWebUploadContentType } from "../../lib/uploads-constants";
import { requiredAuthContext$ } from "../auth/auth-context";
import { request$, setResHeader$, authorization$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { putImmutableS3Object, s3ObjectHead } from "../external/s3";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import {
  canReadMarketingContent$,
  claimMarketingManifest$,
  grantMarketingContent$,
  importMarketingFiles$,
  marketingContentHash,
  marketingHandoffBucket,
  publicMarketingManifestHashes$,
  publishMarketingManifests$,
  readMarketingManifest$,
  storeMarketingManifest$,
} from "../services/marketing-handoff.service";
import type { RouteEntry } from "../route-entry";
import { rejectSuspendedOrg$ } from "../services/org-suspension.service";

const SESSION_COOKIE = "__Host-okou-marketing-handoff";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function signSession(value: string): string {
  return createHmac("sha256", Buffer.from(env("SECRETS_ENCRYPTION_KEY"), "hex"))
    .update(`marketing-handoff-session-v1:${value}`)
    .digest("hex");
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function anonymousSession(cookie: string | undefined): {
  subject: string;
  rolloutUserId: string | undefined;
  rolloutOrgId: string | undefined;
} | null {
  const token = cookie
    ?.split(";")
    .map((part) => {
      return part.trim();
    })
    .find((part) => {
      return part.startsWith(`${SESSION_COOKIE}=`);
    })
    ?.slice(SESSION_COOKIE.length + 1);
  if (!token || token.length > 512) {
    return null;
  }
  const match =
    /^([a-f0-9]{64})\.([0-9]{10,13})\.([A-Za-z0-9_-]{0,100})\.([A-Za-z0-9_-]{0,100})\.([a-f0-9]{64})$/u.exec(
      token,
    );
  if (!match) {
    return null;
  }
  const [, id, expiry, userId, orgId, signature] = match;
  if (!id || !expiry || !signature) {
    return null;
  }
  const expiresAt = Number(expiry);
  const payload = `${id}.${expiry}.${userId}.${orgId}`;
  if (
    expiresAt <= now() ||
    expiresAt > now() + SESSION_TTL_SECONDS * 1000 ||
    !equalSecret(signSession(payload), signature)
  ) {
    return null;
  }
  return {
    subject: `session:${id}`,
    rolloutUserId: userId || undefined,
    rolloutOrgId: orgId || undefined,
  };
}

function trustedOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return false;
  }
  if (
    [
      new URL(env("APP_URL")).origin,
      new URL(env("OKOU_WEB_URL")).origin,
    ].includes(origin)
  ) {
    return true;
  }
  if (env("ENV") === "production") {
    return origin === "https://www.okou.ai" || origin === "https://www.vm0.ai";
  }
  if (!URL.canParse(origin)) {
    return false;
  }
  const url = new URL(origin);
  return (
    url.protocol === "https:" &&
    /^(?:(?:pr-[0-9]+|staging)-(?:www|app)\.(?:omby\.ai|vm6\.ai)|(?:pr-[0-9]+|staging)-app-okou-app-preview\.vm0\.workers\.dev)$/u.test(
      url.host,
    )
  );
}

const handoffContext$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const request = get(request$);
  if (!trustedOrigin(request.header("origin"))) {
    return resourceUnavailable("Marketing handoff origin is not allowed");
  }
  let userId: string | undefined;
  let orgId: string | undefined;
  if (get(authorization$)) {
    const auth = await set(requiredAuthContext$, {}, signal);
    if ("status" in auth) {
      return auth;
    }
    if (auth.tokenType !== "session") {
      return resourceUnavailable("A browser session is required");
    }
    userId = auth.userId;
    orgId = auth.orgId;
  }
  const anonymous = anonymousSession(request.header("cookie"));
  const rolloutUserId = userId ?? anonymous?.rolloutUserId;
  const rolloutOrgId = orgId ?? anonymous?.rolloutOrgId;
  const context =
    rolloutUserId && rolloutOrgId
      ? await set(
          loadUserFeatureSwitchContext$,
          rolloutOrgId,
          rolloutUserId,
          signal,
        )
      : { userId: rolloutUserId, orgId: rolloutOrgId };
  if (!isFeatureEnabled(FeatureSwitchKey.MarketingContentHandoff, context)) {
    return resourceUnavailable("Marketing content handoff is not enabled");
  }
  const bucket = marketingHandoffBucket();
  if (
    !bucket ||
    !env("R2_MARKETING_HANDOFF_ACCESS_KEY_ID") ||
    !env("R2_MARKETING_HANDOFF_SECRET_ACCESS_KEY")
  ) {
    return notConfigured("Marketing handoff storage is not configured");
  }
  const sessionSubject = anonymous?.subject ?? null;
  return {
    bucket,
    userId,
    orgId,
    subject: userId ? `user:${userId}` : sessionSubject,
    sessionSubject,
    rolloutUserId,
    rolloutOrgId,
  };
});

const config$ = command(async ({ set }, signal: AbortSignal) => {
  const context = await set(handoffContext$, signal);
  if ("status" in context) {
    return context.status === 403
      ? { status: 200 as const, body: { enabled: false } }
      : context;
  }
  return { status: 200 as const, body: { enabled: true } };
});

const session$ = command(async ({ get, set }, signal: AbortSignal) => {
  const context = await set(handoffContext$, signal);
  if ("status" in context) {
    return context;
  }
  const body = await get(bodyResultOf(marketingHandoffsContract.session));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const id =
    context.sessionSubject?.slice("session:".length) ??
    randomBytes(32).toString("hex");
  const payload = `${id}.${now() + SESSION_TTL_SECONDS * 1000}.${context.rolloutUserId ?? ""}.${context.rolloutOrgId ?? ""}`;
  set(
    setResHeader$,
    "Set-Cookie",
    `${SESSION_COOKIE}=${payload}.${signSession(payload)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=None`,
  );
  return { status: 200 as const, body: { ready: true as const } };
});

const upload$ = command(async ({ get, set }, signal: AbortSignal) => {
  const context = await set(handoffContext$, signal);
  if ("status" in context) {
    return context;
  }
  if (!context.subject) {
    return resourceUnavailable("Start a handoff session first");
  }
  const body = await get(bodyResultOf(marketingHandoffsContract.upload));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { filename, data } = body.data;
  const content = Buffer.from(data, "base64");
  if (
    content.length > MARKETING_HANDOFF_MAX_FILE_BYTES ||
    content.toString("base64") !== data
  ) {
    return badRequestMessage("Invalid file encoding or size");
  }
  const hash = marketingContentHash(content);
  const contentType = normalizeWebUploadContentType(body.data.contentType);
  await get(
    putImmutableS3Object(
      context.bucket,
      `files/${hash}`,
      content,
      "application/octet-stream",
      signal,
    ),
  );
  signal.throwIfAborted();
  await set(
    grantMarketingContent$,
    { resourceType: "file", resourceHash: hash, subject: context.subject },
    signal,
  );
  return {
    status: 200 as const,
    body: { hash, filename, contentType, size: content.length },
  };
});

const create$ = command(async ({ get, set }, signal: AbortSignal) => {
  const context = await set(handoffContext$, signal);
  if ("status" in context) {
    return context;
  }
  if (!context.subject) {
    return resourceUnavailable("Start a handoff session first");
  }
  const body = await get(bodyResultOf(marketingHandoffsContract.create));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  for (const file of body.data.files) {
    if (
      !(await set(
        canReadMarketingContent$,
        {
          resourceType: "file",
          resourceHash: file.hash,
          subjects: [context.subject],
        },
        signal,
      ))
    ) {
      return notFound("File not found");
    }
    const stored = await get(
      s3ObjectHead(context.bucket, `files/${file.hash}`),
    );
    signal.throwIfAborted();
    if (stored.kind === "missing") {
      return notFound("File not found");
    }
    if (stored.contentLength !== file.size) {
      return badRequestMessage("File size does not match uploaded content");
    }
  }
  const result = await set(
    storeMarketingManifest$,
    { bucket: context.bucket, manifest: body.data, subject: context.subject },
    signal,
  );
  return "status" in result ? result : { status: 200 as const, body: result };
});

const authorizedManifest$ = command(
  async ({ set }, hash: string, signal: AbortSignal) => {
    const context = await set(handoffContext$, signal);
    if ("status" in context) {
      return context;
    }
    if (!context.userId) {
      return resourceUnavailable("Sign in to receive this content");
    }
    const stored = await set(
      readMarketingManifest$,
      { bucket: context.bucket, hash },
      signal,
    );
    if (!stored) {
      return notFound("Content not found");
    }
    const { hash: resourceHash, manifest } = stored;
    const subjects = [context.subject, context.sessionSubject].filter(
      (subject): subject is string => {
        return subject !== null;
      },
    );
    if (
      !(await set(
        canReadMarketingContent$,
        { resourceType: "manifest", resourceHash, subjects },
        signal,
      ))
    ) {
      return notFound("Content not found");
    }
    const claimed = await set(
      claimMarketingManifest$,
      {
        hash: resourceHash,
        userId: context.userId,
        sessionSubject: context.sessionSubject,
        manifest,
      },
      signal,
    );
    if (!claimed) {
      return notFound("Content not found");
    }
    return { ...context, userId: context.userId, manifest, hash: resourceHash };
  },
);

const resolve$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(marketingHandoffsContract.resolve));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { hash } = get(pathParamsOf(marketingHandoffsContract.resolve));
  const result = await set(authorizedManifest$, hash, signal);
  return "status" in result
    ? result
    : { status: 200 as const, body: result.manifest };
});

const import$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(marketingHandoffsContract.import));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { hash } = get(pathParamsOf(marketingHandoffsContract.import));
  const result = await set(authorizedManifest$, hash, signal);
  if ("status" in result) {
    return result;
  }
  if (!result.orgId) {
    return resourceUnavailable("Choose a workspace before importing files");
  }
  const suspended = await set(rejectSuspendedOrg$, result.orgId, signal);
  if (suspended) {
    return suspended;
  }
  const files = await set(
    importMarketingFiles$,
    { ...result, orgId: result.orgId, intentId: body.data.intentId },
    signal,
  );
  return { status: 200 as const, body: { files } };
});

/** Only the trusted Marketing release publisher may grant public access. */
const publisherContext$ = command(({ get, set }) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const token = env("MARKETING_HANDOFF_PUBLISH_TOKEN");
  const provided = get(authorization$);
  if (!token || !provided || !equalSecret(provided, `Bearer ${token}`)) {
    return resourceUnavailable("Publisher authentication required");
  }
  const bucket = marketingHandoffBucket();
  return bucket
    ? { bucket }
    : notConfigured("Marketing handoff storage is not configured");
});

const publishFile$ = command(async ({ get, set }, signal: AbortSignal) => {
  const context = set(publisherContext$);
  if ("status" in context) {
    return context;
  }
  const body = await get(bodyResultOf(marketingHandoffsContract.publishFile));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { data, filename } = body.data;
  const bytes = Buffer.from(data, "base64");
  if (
    bytes.length > MARKETING_HANDOFF_MAX_FILE_BYTES ||
    bytes.toString("base64") !== data
  ) {
    return badRequestMessage("Invalid file encoding or size");
  }
  const hash = marketingContentHash(bytes);
  await get(
    putImmutableS3Object(
      context.bucket,
      `files/${hash}`,
      bytes,
      "application/octet-stream",
      signal,
    ),
  );
  signal.throwIfAborted();
  await set(
    grantMarketingContent$,
    { resourceType: "file", resourceHash: hash, subject: "public" },
    signal,
  );
  return {
    status: 200 as const,
    body: {
      hash,
      filename,
      contentType: normalizeWebUploadContentType(body.data.contentType),
      size: bytes.length,
    },
  };
});

const publish$ = command(async ({ get, set }, signal: AbortSignal) => {
  const context = set(publisherContext$);
  if ("status" in context) {
    return context;
  }
  const { bucket } = context;
  const body = await get(bodyResultOf(marketingHandoffsContract.publish));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  for (const file of body.data.files) {
    if (
      !(await set(
        canReadMarketingContent$,
        { resourceType: "file", resourceHash: file.hash, subjects: [] },
        signal,
      ))
    ) {
      return notFound("Publish files before publishing a manifest");
    }
  }
  const result = await set(
    storeMarketingManifest$,
    { bucket, manifest: body.data, subject: "public" },
    signal,
  );
  return "status" in result ? result : { status: 200 as const, body: result };
});

const publishStatus$ = command(async ({ get, set }, signal: AbortSignal) => {
  const context = set(publisherContext$);
  if ("status" in context) {
    return context;
  }
  const body = await get(bodyResultOf(marketingHandoffsContract.publishStatus));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const hashes = [...new Set(body.data.hashes)];
  const published = await set(
    publicMarketingManifestHashes$,
    { bucket: context.bucket, hashes },
    signal,
  );
  return {
    status: 200 as const,
    body: {
      shortAddressesVerified: true as const,
      missing: hashes.filter((hash) => {
        return !published.has(hash);
      }),
    },
  };
});

const publishBatch$ = command(async ({ get, set }, signal: AbortSignal) => {
  const context = set(publisherContext$);
  if ("status" in context) {
    return context;
  }
  const body = await get(bodyResultOf(marketingHandoffsContract.publishBatch));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  if (
    body.data.manifests.some((manifest) => {
      return (
        Buffer.byteLength(serializeMarketingHandoff(manifest)) >
        manifestPolicy.maxBytes
      );
    })
  ) {
    return badRequestMessage("Handoff manifest is too large");
  }
  const hashes = await set(
    publishMarketingManifests$,
    { bucket: context.bucket, manifests: body.data.manifests },
    signal,
  );
  if (!hashes) {
    return notFound("Publish files before publishing a manifest");
  }
  if (!Array.isArray(hashes)) {
    return hashes;
  }
  return { status: 200 as const, body: { hashes } };
});

const manifestPolicy: Readonly<{ maxBytes: number; tooLargeMessage: string }> =
  {
    maxBytes: 128 * 1024,
    tooLargeMessage: "Handoff manifest is too large",
  };
export const marketingHandoffsRoutes: readonly RouteEntry[] = [
  { route: marketingHandoffsContract.config, handler: config$ },
  {
    route: marketingHandoffsContract.session,
    handler: session$,
    requestBodyPolicy: manifestPolicy,
  },
  {
    route: marketingHandoffsContract.upload,
    handler: upload$,
    requestBodyPolicy: {
      maxBytes: Math.ceil(MARKETING_HANDOFF_MAX_FILE_BYTES / 3) * 4 + 2048,
      tooLargeMessage: "File is too large",
    },
  },
  {
    route: marketingHandoffsContract.create,
    handler: create$,
    requestBodyPolicy: manifestPolicy,
  },
  {
    route: marketingHandoffsContract.resolve,
    handler: resolve$,
    requestBodyPolicy: manifestPolicy,
  },
  {
    route: marketingHandoffsContract.import,
    handler: import$,
    requestBodyPolicy: manifestPolicy,
  },
  {
    route: marketingHandoffsContract.publish,
    handler: publish$,
    requestBodyPolicy: manifestPolicy,
  },
  {
    route: marketingHandoffsContract.publishFile,
    handler: publishFile$,
    requestBodyPolicy: {
      maxBytes: Math.ceil(MARKETING_HANDOFF_MAX_FILE_BYTES / 3) * 4 + 2048,
      tooLargeMessage: "File is too large",
    },
  },
  {
    route: marketingHandoffsContract.publishStatus,
    handler: publishStatus$,
    requestBodyPolicy: manifestPolicy,
  },
  {
    route: marketingHandoffsContract.publishBatch,
    handler: publishBatch$,
    requestBodyPolicy: {
      maxBytes: 512 * 1024,
      tooLargeMessage: "Handoff publication batch is too large",
    },
  },
];
