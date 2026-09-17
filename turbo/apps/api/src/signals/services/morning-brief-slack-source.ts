/**
 * Slack's bundle, expressed as source-neutral evidence.
 *
 * Slack is the one collector on `main`, so it is where the composed shape is
 * proved rather than described. The translation is deliberately lossless in the
 * directions that matter later: the workspace and the member's own Slack
 * identity stay attached so the shared authorizer can recheck them, and Slack's
 * fractional timestamps stay verbatim as the record identity so a half-open
 * window edge is never rounded away by a `Date` round trip.
 *
 * The rules are described in
 * [the composition contract](../../../../../../docs/morning-brief-composition.md).
 */

import type { MorningBriefSlackBundle } from "@okouai/api-contracts/contracts/morning-brief-collection-preview";

import {
  morningBriefScopeDigest,
  type MorningBriefRetainedSourceDescriptor,
} from "./morning-brief-source-authority";
import type {
  MorningBriefSourceCollection,
  MorningBriefSourceCoverage,
  MorningBriefSourceItem,
} from "./morning-brief-source-item";

/**
 * A Slack timestamp as an instant, without becoming the record's identity.
 *
 * `1726500000.000100` carries microseconds that a millisecond `Date` cannot
 * hold, so the string stays the identity and this value is only ever used for
 * ordering and display.
 */
function slackInstant(ts: string): Date {
  return new Date(Number.parseFloat(ts) * 1000);
}

function slackCoverage(
  bundle: MorningBriefSlackBundle,
): MorningBriefSourceCoverage {
  if (bundle.coverage === "partial") {
    return "partial";
  }
  return bundle.entries.length === 0 ? "empty" : "complete";
}

/**
 * Normalize one collected Slack bundle.
 *
 * Entries are ranked newest first, which is the priority the request allocator
 * consumes when Slack has to give up its later turns in a round.
 */
export function normalizeMorningBriefSlack(
  bundle: MorningBriefSlackBundle,
  binding: {
    readonly workspaceId: string;
    readonly slackUserId: string;
  },
): MorningBriefSourceCollection {
  const channelNames = new Map(
    bundle.channels.map((channel) => {
      return [channel.id, channel];
    }),
  );
  const account = `${binding.workspaceId}:${binding.slackUserId}`;
  const ranked = [...bundle.entries].sort((left, right) => {
    return slackInstant(right.ts).getTime() - slackInstant(left.ts).getTime();
  });
  const items: MorningBriefSourceItem[] = ranked.map((entry, index) => {
    const channel = channelNames.get(entry.channelId);
    return {
      identity: {
        source: "slack",
        account,
        container: entry.channelId,
        record: entry.ts,
        instance: entry.threadTs,
      },
      priority: index,
      occurredAt: slackInstant(entry.ts),
      // A Slack message is an instant inside the collected half-open window;
      // a reply pulled from an older root is still reported at its own time.
      timeSemantics: "instant",
      endsAt: null,
      title: `#${entry.channelName}`,
      body: entry.text,
      // Slack clips a long message at its own ceiling on a code point
      // boundary; carrying that through is what stops the brief from treating
      // a fragment as the whole message.
      truncated: entry.textTruncated,
      links:
        channel === undefined
          ? [{ label: `#${entry.channelName}`, url: entry.channelUrl }]
          : [{ label: `#${channel.name}`, url: channel.url }],
    };
  });
  return {
    source: "slack",
    coverage: slackCoverage(bundle),
    items,
    requests: bundle.counts.requests,
    omittedBySource: 0,
  };
}

/**
 * The Slack authorization surface this collector actually exercises.
 *
 * These are the exact methods `lib/slack-client` calls for a Morning Brief, so
 * the digest describes what was authorized rather than a scope list nobody
 * observed. `main`'s native reader does not surface the workspace's granted
 * scope set; live scope and coverage are #34861's, and when that lands the same
 * digest can be taken over the granted scopes without changing what a narrowed
 * grant means here — a revalidation that no longer covers these methods fails
 * either way.
 */
export const MORNING_BRIEF_SLACK_READ_SURFACE: readonly string[] = [
  "users.conversations",
  "conversations.history",
  "conversations.replies",
];

/**
 * The credential-free descriptor a later phase revalidates Slack against.
 *
 * Slack's native installation is the organization's own bot intersected with
 * this member's connected account, so there is no per-user connector row to
 * name: the workspace and member identity are the authorization evidence, and
 * the bot token that made the read deliberately never reaches this record.
 */
export function morningBriefSlackDescriptor(args: {
  readonly workspaceId: string;
  readonly slackUserId: string;
  readonly membershipId: string;
  readonly agentId: string;
  readonly capturedAt: Date;
  readonly contributed: boolean;
  /** The shared channels this attempt actually read from. */
  readonly containers: readonly string[];
}): MorningBriefRetainedSourceDescriptor {
  return {
    source: "slack",
    connectionId: null,
    accountRef: `${args.workspaceId}:${args.slackUserId}`,
    scopeDigest: morningBriefScopeDigest(MORNING_BRIEF_SLACK_READ_SURFACE),
    membershipId: args.membershipId,
    agentId: args.agentId,
    capturedAt: args.capturedAt.toISOString(),
    contributed: args.contributed,
    containers: args.containers,
  };
}
