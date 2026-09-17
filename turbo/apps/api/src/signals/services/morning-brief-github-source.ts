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
  morningBriefScopeDigest,
  type MorningBriefRetainedSourceDescriptor,
} from "./morning-brief-source-authority";
import type {
  MorningBriefSourceCollection,
  MorningBriefSourceCoverage,
  MorningBriefSourceItem,
  MorningBriefTimeSemantics,
} from "./morning-brief-source-item";

/** The GitHub authorization surface a Morning Brief read exercises. */
const MORNING_BRIEF_GITHUB_READ_SURFACE: readonly string[] = [
  "notifications",
  "repo",
  "read:user",
];

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
): MorningBriefTimeSemantics {
  return item.reasons.some((reason) => {
    return reason.branch === "notification";
  })
    ? "instant"
    : "outstanding";
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
      title: record.title,
      body: record.excerpt ?? "",
      // An absent excerpt on a record that has a body is a coverage gap the
      // collector declared, not an empty description.
      truncated: record.excerpt === undefined,
      links: url === undefined ? [] : [{ label: "Open on GitHub", url }],
    };
  });
  return {
    source: "github",
    coverage: githubCoverage(bundle),
    items,
    requests: Object.values(bundle.branches).reduce((total, branch) => {
      return total + branch.pages;
    }, 0),
    omittedBySource: 0,
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
  readonly connectionId: string | null;
  readonly membershipId: string;
  readonly agentId: string;
  readonly capturedAt: Date;
  readonly contributed: boolean;
  readonly containers: readonly string[];
}): MorningBriefRetainedSourceDescriptor {
  return {
    source: "github",
    connectionId: args.connectionId,
    accountRef: args.login,
    scopeDigest: morningBriefScopeDigest(MORNING_BRIEF_GITHUB_READ_SURFACE),
    membershipId: args.membershipId,
    agentId: args.agentId,
    capturedAt: args.capturedAt.toISOString(),
    contributed: args.contributed,
    containers: args.containers,
  };
}
