import { isDeepStrictEqual } from "node:util";
import type {
  SocialDataJobResponse,
  SocialDataRecord,
  SocialDataResult,
} from "@okouai/api-contracts/contracts/social-data";
import type { socialDataJobs } from "@okouai/db/schema/social-data-job";
import type { SocialDataJobCollectionProgress } from "@okouai/db/jsonb-contracts/social-data-job";
import type { SocialDataProviderRun } from "./social-data-provider";

type Job = typeof socialDataJobs.$inferSelect;
interface CompletedPage {
  readonly result: SocialDataResult;
  readonly collectionProgress?: SocialDataJobCollectionProgress;
  readonly nextProviderCursor?: Job["nextProviderCursor"];
}

export function socialDataCollectionView(
  job: Job,
): SocialDataJobResponse["collection"] {
  const progress = job.collectionProgress;
  if (!progress) {
    return undefined;
  }
  return {
    requestedItems: progress.totalLimit,
    itemsReturned:
      job.result && "items" in job.result ? job.result.items.length : 0,
    cumulativeItemsReturned: progress.deliveredCount,
    hasMore: progress.hasMore,
    continuationAvailable:
      job.status === "completed" &&
      job.creditsCharged !== null &&
      job.nextProviderCursor !== null &&
      progress.deliveredCount < progress.totalLimit,
    ...(job.sourceJobId ? { sourceJobId: job.sourceJobId } : {}),
  };
}

function deduplicatedPage(
  items: readonly SocialDataRecord[],
  progress: SocialDataJobCollectionProgress,
) {
  const seen = new Set(progress.seenKeys);
  const remaining = progress.totalLimit - progress.deliveredCount;
  const accepted: SocialDataRecord[] = [];
  for (const item of items) {
    if (accepted.length >= remaining) {
      break;
    }
    if (!item.id) {
      throw new Error("Completed China Social data record has no ID");
    }
    const key = `id:${item.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    accepted.push(item);
  }
  return { items: accepted, seenKeys: [...seen] };
}

function nextPageCursor(
  job: Job,
  outcome: SocialDataProviderRun,
  hasMore: boolean | null,
): Job["nextProviderCursor"] {
  // A repeated cursor is not a safe next page; do not turn an upstream loop into repeated charges.
  return hasMore !== false &&
    outcome.nextCursor &&
    !isDeepStrictEqual(job.providerCursor, outcome.nextCursor)
    ? outcome.nextCursor
    : null;
}

/** A page is one billed run. Only identities already delivered by this chain are deduplicated. */
export function completedSocialDataPage(
  job: Job,
  outcome: SocialDataProviderRun,
): CompletedPage {
  // A settlement retry must not deduplicate this page against its own already
  // committed identities or replace its delivered result with an empty page.
  if (job.status === "completed" && job.result) {
    return {
      result: job.result,
      collectionProgress: job.collectionProgress ?? undefined,
      nextProviderCursor: job.nextProviderCursor,
    };
  }
  const data = outcome.data;
  if (!data) {
    throw new Error("Completed Social data page has no result");
  }
  if (
    (job.platform !== "douyin" && job.platform !== "weibo") ||
    !("items" in data) ||
    job.operation === "inspect"
  ) {
    return { result: data };
  }
  const prior = job.collectionProgress ?? {
    rootJobId: job.id,
    totalLimit: job.request.limit,
    deliveredCount: 0,
    seenKeys: [],
    hasMore: null,
  };
  const page = deduplicatedPage(data.items, prior);
  const hasMore = outcome.hasMore ?? null;
  return {
    result: { ...data, items: page.items, pagination: { hasMore } },
    collectionProgress: {
      ...prior,
      deliveredCount: prior.deliveredCount + page.items.length,
      seenKeys: page.seenKeys,
      hasMore,
    },
    nextProviderCursor: nextPageCursor(job, outcome, hasMore),
  };
}
