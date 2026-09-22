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
  morningBriefItemFacts,
  type MorningBriefSourceCollection,
  type MorningBriefSourceCoverage,
  type MorningBriefSourceItem,
  type MorningBriefSourceProvenance,
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
 * The half-open window and the channels this bundle was drawn from.
 *
 * A channel whose own history was bounded before the window end is named, so a
 * complete-looking bundle cannot hide a conversation that was cut short.
 */
function slackProvenance(
  bundle: MorningBriefSlackBundle,
): MorningBriefSourceProvenance {
  return {
    startAt: bundle.windowStart,
    endAt: bundle.windowEnd,
    startDate: null,
    endDateExclusive: null,
    timezone: bundle.timezone,
    observedAt: null,
    collectedAt: null,
    branches: bundle.channels.map((channel) => {
      return {
        name: channel.id,
        status: channel.truncated ? "truncated" : "complete",
        startAt: bundle.windowStart,
        endAt: bundle.windowEnd,
        observedAt: null,
      };
    }),
    limitations: bundle.limits,
  };
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
      dateRange: null,
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
      // The exact timestamp travels verbatim beside the millisecond `Date` it
      // was ordered by, because Slack's microseconds do not survive that trip.
      facts: morningBriefItemFacts({
        reasons: [
          {
            branch: entry.fromThread ? "thread" : "channel",
            detail: entry.threadTs,
            unread: null,
          },
        ],
        startedAtRaw: entry.ts,
        actor: entry.authorId,
      }),
    };
  });
  return {
    source: "slack",
    coverage: slackCoverage(bundle),
    items,
    requests: bundle.counts.requests,
    provenance: slackProvenance(bundle),
    omittedBySource: {
      known: 0,
      unknownRemaining:
        bundle.limits.length > 0 ||
        bundle.channels.some((channel) => {
          return channel.truncated;
        }),
    },
  };
}
