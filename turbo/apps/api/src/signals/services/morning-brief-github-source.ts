/**
 * GitHub's bundle, expressed as source-neutral evidence.
 *
 * GitHub's evidence is mostly *outstanding* rather than *new*: a review request
 * from last week that is still unanswered belongs in a morning brief, and its
 * `updatedAt` is not a claim that anything happened during the window. Marking
 * it as an instant would let the brief report a stale obligation as this
 * morning's news, so the branch that selected it decides.
 *
 * The rules are described in
 * [the composition contract](../../../../../../docs/morning-brief-composition.md).
 */

import type {
  MorningBriefGithubBundle,
  MorningBriefGithubItem,
} from "@okouai/api-contracts/contracts/morning-brief-github-collection";

import {
  morningBriefProvenAuthority,
  type MorningBriefSourceAuthorityProof,
  type MorningBriefRetainedSourceDescriptor,
} from "./morning-brief-source-authority";
import {
  morningBriefItemFacts,
  type MorningBriefSourceBranch,
  type MorningBriefSourceCollection,
  type MorningBriefSourceCoverage,
  type MorningBriefSourceItem,
  type MorningBriefSourceProvenance,
} from "./morning-brief-source-item";

/**
 * Whether this record is window activity or standing obligation.
 *
 * Only a notification is evidence that something happened inside the collected
 * window. Everything else — a review request, an assigned issue, a failing
 * check on an open pull request — is work that is still outstanding and may
 * predate the window entirely.
 */
function githubTimeSemantics(
  item: MorningBriefGithubItem,
): "instant" | "outstanding" {
  return item.reasons.some((reason) => {
    return reason.branch === "notification";
  })
    ? "instant"
    : "outstanding";
}

/**
 * One branch's own window or snapshot, as the collector declared it.
 *
 * The three selection branches do not share a window: notifications cover a
 * half-open range, while assigned work and review requests are snapshots of
 * what is outstanding right now. Flattening them into one collection time
 * turns "still waiting for your review" into "happened this morning".
 */
function githubBranches(
  bundle: MorningBriefGithubBundle,
): readonly MorningBriefSourceBranch[] {
  return Object.entries(bundle.branches).map(([name, branch]) => {
    return {
      name,
      status: branch.status,
      startAt: branch.windowStart ?? null,
      endAt: branch.windowEnd ?? null,
      observedAt: branch.observedAt ?? null,
    };
  });
}

function githubProvenance(
  bundle: MorningBriefGithubBundle,
): MorningBriefSourceProvenance {
  return {
    startAt: bundle.branches.notifications.windowStart ?? null,
    endAt: bundle.branches.notifications.windowEnd ?? null,
    startDate: null,
    endDateExclusive: null,
    timezone: bundle.timezone,
    observedAt: bundle.observedAt,
    collectedAt: bundle.collectedAt,
    branches: githubBranches(bundle),
    limitations: bundle.limits,
  };
}

function githubCoverage(
  bundle: MorningBriefGithubBundle,
): MorningBriefSourceCoverage {
  if (bundle.coverage === "partial") {
    return "partial";
  }
  return bundle.items.length === 0 ? "empty" : "complete";
}

/**
 * Normalize one GitHub bundle.
 *
 * Window activity ranks ahead of standing backlog, and within each group the
 * most recently updated record leads.
 */
export function normalizeMorningBriefGithub(
  bundle: MorningBriefGithubBundle,
): MorningBriefSourceCollection {
  const ranked = [...bundle.items].sort((left, right) => {
    const leftNew = githubTimeSemantics(left) === "instant" ? 0 : 1;
    const rightNew = githubTimeSemantics(right) === "instant" ? 0 : 1;
    if (leftNew !== rightNew) {
      return leftNew - rightNew;
    }
    return (
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    );
  });
  const items: MorningBriefSourceItem[] = ranked.map((record, index) => {
    const url = record.url;
    const checks = record.checks;
    return {
      identity: {
        source: "github",
        // The exact login of the selected token, from `GET /user` — never the
        // process account or an environment token's identity.
        account: bundle.login,
        container: record.repository,
        // The kind is part of the identity: a repository can carry issue #12
        // and pull request #12 as two different records.
        record: `${record.kind}#${record.number.toString()}`,
        instance: null,
      },
      priority: index,
      occurredAt: new Date(record.updatedAt),
      timeSemantics: githubTimeSemantics(record),
      endsAt: null,
      dateRange: null,
      title: record.title,
      body: record.excerpt ?? "",
      // An absent excerpt on a record that has a body is a coverage gap the
      // collector declared, not an empty description.
      truncated: record.excerpt === undefined,
      links: url === undefined ? [] : [{ label: "Open on GitHub", url }],
      // Every branch that selected the record, its open/closed state and the
      // exact head its checks describe. Two records that differ only in these
      // are two different obligations, and a normalization that drops them
      // makes "review requested, head failing" and "assigned, head green"
      // indistinguishable.
      facts: morningBriefItemFacts({
        reasons: record.reasons.map((reason) => {
          return {
            branch: reason.branch,
            detail: reason.notificationReason ?? null,
            unread: reason.unread ?? null,
          };
        }),
        state: record.state,
        draft: record.draft ?? null,
        startedAtRaw: record.updatedAt,
        actor: record.actor ?? null,
        checks:
          checks === undefined
            ? null
            : {
                headSha: checks.headSha,
                state: checks.state,
                failing: checks.failing,
                pending: checks.pending,
                succeeded: checks.succeeded,
                failingNames: checks.failingNames,
                incomplete: checks.incomplete,
              },
      }),
    };
  });
  return {
    source: "github",
    coverage: githubCoverage(bundle),
    items,
    // The collector's own count of provider reads, including refusals. Summing
    // branch pages counted list pages only and missed every pull request
    // detail, check run and status read the same collection spent.
    requests: bundle.counts.requests,
    provenance: githubProvenance(bundle),
    // GitHub names the caps that fired but never counts what was on the other
    // side of them, so the remainder stays explicitly unknown instead of
    // becoming a total nothing observed.
    omittedBySource: { known: 0, unknownRemaining: bundle.limits.length > 0 },
  };
}

/**
 * The credential-free descriptor a later phase revalidates GitHub against.
 *
 * `accountRef` is the login the collector resolved from the member's selected
 * connection, and `containers` names the repositories that contributed, so a
 * later check can ask about the real scope of this input.
 */
export function morningBriefGithubDescriptor(args: {
  readonly login: string;
  /** What this source's reads were actually authorized by, or null. */
  readonly proof: MorningBriefSourceAuthorityProof | null;
  readonly membershipId: string;
  readonly agentId: string;
  readonly capturedAt: Date;
  readonly contributed: boolean;
  readonly containers: readonly string[];
}): MorningBriefRetainedSourceDescriptor {
  const proven = morningBriefProvenAuthority(args.proof);
  return {
    source: "github",
    connectionId: proven.connectionId,
    accountRef: args.login,
    scopeDigest: proven.scopeDigest,
    endpoints: proven.endpoints,
    membershipId: args.membershipId,
    agentId: args.agentId,
    capturedAt: args.capturedAt.toISOString(),
    contributed: args.contributed,
    containers: args.containers,
  };
}
