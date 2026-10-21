import {
  socialDataCreateRequestSchema,
  socialDataProviderCursorSchema,
  type SocialDataContinueRequest,
  type SocialDataRequest,
} from "@okouai/api-contracts/contracts/social-data";
import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import type { AuthContext } from "../../types/auth";
import { writeDb$ } from "../external/db";
import { createSocialDataJob$, quoteSocialData$ } from "./social-data.service";

type Actor = AuthContext & { readonly orgId: string };
function unavailable(status: 404 | 409 | 503, code: string, message: string) {
  return { status, body: { error: { code, message } } };
}

const continuationSource$ = command(
  async (
    { set },
    args: { readonly auth: Actor; readonly jobId: string },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [source] = await db
      .select()
      .from(socialDataJobs)
      .where(
        and(
          eq(socialDataJobs.id, args.jobId),
          eq(socialDataJobs.orgId, args.auth.orgId),
          eq(socialDataJobs.userId, args.auth.userId),
        ),
      );
    signal.throwIfAborted();
    if (!source) {
      return {
        ok: false as const,
        response: unavailable(404, "NOT_FOUND", "Social data job not found."),
      };
    }
    const progress = source.collectionProgress;
    const cursor = socialDataProviderCursorSchema.safeParse(
      source.nextProviderCursor,
    );
    if (source.status !== "completed" || source.creditsCharged === null) {
      return {
        ok: false as const,
        response: unavailable(
          409,
          "SOCIAL_DATA_PAGE_NOT_SETTLED",
          "Wait for the source page to complete and settle before continuing.",
        ),
      };
    }
    if (
      !progress ||
      !cursor.success ||
      progress.hasMore === false ||
      progress.deliveredCount >= progress.totalLimit
    ) {
      return {
        ok: false as const,
        response: unavailable(
          409,
          "SOCIAL_DATA_NO_CONTINUATION",
          "This collection has no trusted next page within its requested limit. An unknown source end is not a proven end.",
        ),
      };
    }
    if (
      !Number.isSafeInteger(progress.totalLimit) ||
      progress.totalLimit < 1 ||
      progress.totalLimit > 1000 ||
      !Number.isSafeInteger(progress.deliveredCount) ||
      progress.deliveredCount < 0 ||
      progress.seenKeys.length > 1000
    ) {
      return {
        ok: false as const,
        response: unavailable(
          503,
          "SOCIAL_DATA_STATE_UNAVAILABLE",
          "The saved collection state requires support to recover.",
        ),
      };
    }
    const {
      requestId: _requestId,
      maxCredits: _maxCredits,
      ...original
    } = socialDataCreateRequestSchema.parse(source.request);
    const request: SocialDataRequest = {
      ...original,
      limit: progress.totalLimit - progress.deliveredCount,
    };
    return { ok: true as const, source, cursor: cursor.data, request };
  },
);

export const quoteSocialDataContinuation$ = command(
  async (
    { set },
    args: { readonly auth: Actor; readonly jobId: string },
    signal: AbortSignal,
  ) => {
    const source = await set(continuationSource$, args, signal);
    signal.throwIfAborted();
    if (!source.ok) {
      return source.response;
    }
    const [successor] = await set(writeDb$)
      .select({ id: socialDataJobs.id })
      .from(socialDataJobs)
      .where(eq(socialDataJobs.sourceJobId, source.source.id));
    signal.throwIfAborted();
    if (successor) {
      return unavailable(
        409,
        "SOCIAL_DATA_PAGE_ALREADY_CONTINUED",
        "This page already has a continuation. Recover it from saved jobs.",
      );
    }
    return await set(
      quoteSocialData$,
      { auth: args.auth, body: source.request, cursor: source.cursor },
      signal,
    );
  },
);

export const continueSocialDataJob$ = command(
  async (
    { set },
    args: {
      readonly auth: Actor;
      readonly jobId: string;
      readonly body: SocialDataContinueRequest;
    },
    signal: AbortSignal,
  ) => {
    const source = await set(continuationSource$, args, signal);
    signal.throwIfAborted();
    if (!source.ok) {
      return source.response;
    }
    // Admission reuses the existing organization-owned billing transaction, reservation and idempotency path.
    return await set(
      createSocialDataJob$,
      {
        auth: args.auth,
        body: { ...source.request, ...args.body },
        source: source.source,
      },
      signal,
    );
  },
);
