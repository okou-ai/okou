import type { MorningBriefGithubBundle } from "@okouai/api-contracts/contracts/morning-brief-github-collection";
import { describe, expect, it } from "vitest";

import {
  allocateMorningBriefRequest,
  morningBriefMayStartRead,
  morningBriefSourceBudget,
  morningBriefSourceWaves,
  MORNING_BRIEF_COLLECTION_PHASE_MS,
  MORNING_BRIEF_FINAL_CHECK_RESERVE_MS,
  MORNING_BRIEF_MAX_CONCURRENT_SOURCES,
  MORNING_BRIEF_NEW_READ_CUTOFF_MS,
  MORNING_BRIEF_REQUEST_MAX_BYTES,
  MORNING_BRIEF_SOURCE_BUDGETS,
} from "../morning-brief-collection-plan";
import {
  MORNING_BRIEF_ARCHIVE_MAX_BYTES,
  MORNING_BRIEF_ARCHIVE_MAX_DECOMPRESSED_BYTES,
  MORNING_BRIEF_INSTRUCTIONS_MAX_BYTES,
  MORNING_BRIEF_MANIFEST_MAX_BYTES,
  morningBriefStoragePhaseExpired,
  morningBriefStoragePhaseExpiresAt,
  morningBriefStoragePhaseRemainingMs,
  MORNING_BRIEF_STORAGE_PHASE_MS,
} from "../morning-brief-language-bounds";
import {
  isMorningBriefOutputLanguage,
  planMorningBriefLanguage,
  validateReportedLanguage,
  MORNING_BRIEF_DEFAULT_LANGUAGE,
  MORNING_BRIEF_OUTPUT_LANGUAGES,
} from "../morning-brief-language-policy";
import { normalizeMorningBriefCalendar } from "../morning-brief-calendar-source";
import { normalizeMorningBriefChat } from "../morning-brief-chat-source";
import { normalizeMorningBriefGithub } from "../morning-brief-github-source";
import { normalizeMorningBriefGmail } from "../morning-brief-gmail-source";
import {
  normalizeMorningBriefSlack,
  MORNING_BRIEF_SLACK_READ_SURFACE,
} from "../morning-brief-slack-source";
import {
  boundMorningBriefDescriptors,
  morningBriefDescriptorRetainUntil,
  morningBriefScopeDigest,
  morningBriefSourcesToRevalidate,
  MORNING_BRIEF_ACCOUNT_REF_MAX_BYTES,
  MORNING_BRIEF_DESCRIPTOR_MAX_BYTES,
  MORNING_BRIEF_DESCRIPTOR_SET_MAX_BYTES,
  MORNING_BRIEF_MAX_RETAINED_DESCRIPTORS,
  MORNING_BRIEF_OUTBOX_DEADLINE_MS,
  MORNING_BRIEF_RESULT_RETENTION_MS,
  type MorningBriefRetainedSourceDescriptor,
} from "../morning-brief-source-authority";
import {
  morningBriefEnvelopeBytes,
  morningBriefRequestBytes,
  buildMorningBriefRequest,
  morningBriefCoverageReport,
  packMorningBriefRequest,
} from "../morning-brief-request-envelope";
import {
  boundCombinedNormalizedItems,
  dedupeMorningBriefItems,
  morningBriefEvidenceDigest,
  morningBriefItemBytes,
  morningBriefItemFacts,
  MORNING_BRIEF_SOURCE_ORDER,
  morningBriefItemsBytes,
  MORNING_BRIEF_COMBINED_NORMALIZED_MAX_BYTES,
  MORNING_BRIEF_NO_OMISSIONS,
  MORNING_BRIEF_NO_PROVENANCE,
  serializeMorningBriefAggregate,
  type MorningBriefSourceCollection,
  type MorningBriefSourceItem,
  serializeMorningBriefItem as serializeForTest,
  type MorningBriefSourceKind,
} from "../morning-brief-source-item";

function bundleFixture() {
  return {
    source: "slack" as const,
    version: 1,
    workspaceId: "T123",
    windowStart: "2026-09-16T06:00:00.000Z",
    windowEnd: "2026-09-17T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    coverage: "complete" as const,
    limits: [],
    channels: [
      {
        id: "C1",
        name: "general",
        url: "https://example.slack.com/archives/C1",
        isPrivate: false,
        truncated: false,
      },
    ],
    entries: [
      {
        channelId: "C1",
        channelName: "general",
        channelUrl: "https://example.slack.com/archives/C1",
        ts: "1789000000.000100",
        threadTs: null,
        authorId: "U9",
        text: "older",
        textTruncated: false,
        fromThread: false,
      },
      {
        channelId: "C1",
        channelName: "general",
        channelUrl: "https://example.slack.com/archives/C1",
        ts: "1789000600.000200",
        threadTs: "1789000000.000100",
        authorId: "U9",
        text: "newer reply",
        textTruncated: true,
        fromThread: true,
      },
    ],
    counts: {
      channels: 1,
      threads: 1,
      messages: 2,
      requests: 3,
      textBytes: 16,
    },
  };
}

function item(
  source: MorningBriefSourceKind,
  record: string,
  overrides: Partial<
    Omit<
      MorningBriefSourceItem,
      "occurredAt" | "timeSemantics" | "endsAt" | "dateRange"
    >
  > = {},
): MorningBriefSourceItem {
  return {
    identity: {
      source,
      account: `${source}-account`,
      container: `${source}-container`,
      record,
      instance: null,
    },
    priority: 0,
    occurredAt: new Date("2026-09-17T06:00:00.000Z"),
    timeSemantics: "instant",
    endsAt: null,
    dateRange: null,
    title: record,
    body: "",
    truncated: false,
    links: [],
    facts: morningBriefItemFacts({}),
    ...overrides,
  };
}

/** The exact bytes a caller measuring the aggregate document would see. */
function aggregateOracle(
  collections: readonly MorningBriefSourceCollection[],
): number {
  return Buffer.byteLength(
    JSON.stringify(serializeMorningBriefAggregate(collections)),
    "utf8",
  );
}

function collection(
  source: MorningBriefSourceKind,
  items: readonly MorningBriefSourceItem[],
): MorningBriefSourceCollection {
  return {
    source,
    coverage: items.length === 0 ? "empty" : "complete",
    items,
    requests: 0,
    provenance: MORNING_BRIEF_NO_PROVENANCE,
    omittedBySource: MORNING_BRIEF_NO_OMISSIONS,
  };
}

describe("normalized evidence identity", () => {
  it("keeps two provider records that only share a title", () => {
    const deduped = dedupeMorningBriefItems([
      item("calendar", "event-a", { title: "Weekly sync" }),
      item("gmail", "message-b", { title: "Weekly sync" }),
    ]);

    expect(deduped).toHaveLength(2);
  });

  it("keeps the same meeting held in two calendars", () => {
    const deduped = dedupeMorningBriefItems([
      item("calendar", "event-a", {
        identity: {
          source: "calendar",
          account: "work",
          container: "primary",
          record: "event-a",
          instance: null,
        },
      }),
      item("calendar", "event-a", {
        identity: {
          source: "calendar",
          account: "work",
          container: "team",
          record: "event-a",
          instance: null,
        },
      }),
    ]);

    expect(deduped).toHaveLength(2);
  });

  it("drops a repeat of one provider record, including its recurrence instance", () => {
    const identity = {
      source: "calendar" as const,
      account: "work",
      container: "primary",
      record: "event-a",
      instance: "2026-09-17",
    };
    const deduped = dedupeMorningBriefItems([
      item("calendar", "event-a", { identity }),
      item("calendar", "event-a", { identity, title: "later copy" }),
      item("calendar", "event-a", {
        identity: { ...identity, instance: "2026-09-18" },
      }),
    ]);

    expect(deduped).toHaveLength(2);
    expect(deduped[0]?.title).toBe("event-a");
  });
});

describe("combined normalized ceiling", () => {
  it("accepts an aggregate that exactly reaches the cap and rejects one byte more", () => {
    // Escaping, non-ASCII and a control character all have to be charged at
    // their serialized width, and the metadata travelling beside the items is
    // part of the same document.
    const only = item("slack", "m1", {
      body: '早安"\u0001'.repeat(50),
      facts: morningBriefItemFacts({ startedAtRaw: "1789000000.000100" }),
    });
    const collections = [
      { ...collection("slack", [only]), coverage: "partial" as const },
    ];
    // The oracle is the document a consumer serializes, not the bound's counter.
    const exact = aggregateOracle(collections);

    const fitted = boundCombinedNormalizedItems(collections, exact);
    expect(fitted.omitted).toBe(0);
    expect(fitted.bytes).toBe(exact);
    expect(aggregateOracle(fitted.collections)).toBe(exact);

    const overflowed = boundCombinedNormalizedItems(collections, exact - 1);
    expect(overflowed.omitted).toBe(1);
    expect(overflowed.collections[0]?.items).toHaveLength(0);
    expect(overflowed.bytes).toBeLessThan(exact);
  });

  it("keeps a complete source inside the exact cap without a partial-status underestimate", () => {
    const only = item("calendar", "e1", {
      body: '跨日"会议',
    });
    const collections = [collection("calendar", [only])];
    const exact = aggregateOracle(collections);

    const fitted = boundCombinedNormalizedItems(collections, exact);
    expect(fitted.omitted).toBe(0);
    expect(fitted.collections[0]?.coverage).toBe("complete");
    expect(aggregateOracle(fitted.collections)).toBe(exact);

    const overflowed = boundCombinedNormalizedItems(collections, exact - 1);
    expect(overflowed.omitted).toBe(1);
    expect(overflowed.collections[0]?.coverage).toBe("partial");
    expect(aggregateOracle(overflowed.collections)).toBeLessThanOrEqual(
      exact - 1,
    );
  });

  it("charges the metadata that travels with the items", () => {
    const only = item("slack", "m1", { body: "x".repeat(40) });
    const plain: MorningBriefSourceCollection = {
      ...collection("slack", [only]),
      coverage: "partial",
    };
    const described: MorningBriefSourceCollection = {
      ...plain,
      requests: 11,
      provenance: {
        ...MORNING_BRIEF_NO_PROVENANCE,
        startAt: "2026-09-16T06:00:00.000Z",
        endAt: "2026-09-17T06:00:00.000Z",
        timezone: "Asia/Shanghai",
        limitations: ["response-bytes", "deadline"],
      },
    };
    const plainCap = aggregateOracle([plain]);

    // The same item, the same cap: the provenance and limitation metadata is
    // part of the bounded document, so it is what pushes this one over.
    expect(boundCombinedNormalizedItems([plain], plainCap).omitted).toBe(0);
    expect(boundCombinedNormalizedItems([described], plainCap).omitted).toBe(1);
  });

  it("drops whole items and reports the source as partial", () => {
    const first = item("slack", "m1", { body: "a".repeat(40), priority: 0 });
    const second = item("slack", "m2", { body: "b".repeat(40), priority: 1 });
    const bounded = boundCombinedNormalizedItems(
      [collection("slack", [first, second])],
      aggregateOracle([
        { ...collection("slack", [first]), coverage: "partial" as const },
      ]),
    );

    expect(bounded.omitted).toBe(1);
    expect(bounded.omittedBySource.slack).toBe(1);
    expect(bounded.collections[0]?.items).toHaveLength(1);
    expect(bounded.collections[0]?.items[0]?.body).toBe("a".repeat(40));
    expect(bounded.collections[0]?.coverage).toBe("partial");
  });

  it("leaves an unconfigured source unconfigured rather than calling it empty", () => {
    const bounded = boundCombinedNormalizedItems([
      { ...collection("github", []), coverage: "unconfigured" },
      collection("slack", [item("slack", "m1")]),
    ]);

    const github = bounded.collections.find((entry) => {
      return entry.source === "github";
    });
    expect(github?.coverage).toBe("unconfigured");
  });
});

describe("source-fair request allocation", () => {
  it("does not let a large early source starve every later source", () => {
    const gmail = Array.from({ length: 40 }, (_, index) => {
      return item("gmail", `m${index.toString()}`, {
        body: "g".repeat(200),
        priority: index,
      });
    });
    const chat = [item("chat", "c0", { body: "c".repeat(200) })];
    const budget =
      morningBriefItemBytes(gmail[0] as MorningBriefSourceItem) * 6;

    const allocated = allocateMorningBriefRequest(
      [collection("gmail", gmail), collection("chat", chat)],
      { maxBytes: budget },
    );

    expect(
      allocated.items.some((accepted) => {
        return accepted.identity.source === "chat";
      }),
    ).toBeTruthy();
    expect(allocated.omittedItems).toBeGreaterThan(0);
    expect(allocated.bytes).toBeLessThanOrEqual(budget);
  });

  it("takes sources in the fixed order within a round", () => {
    const allocated = allocateMorningBriefRequest([
      collection("chat", [item("chat", "c0")]),
      collection("calendar", [item("calendar", "e0")]),
      collection("gmail", [item("gmail", "m0")]),
    ]);

    expect(
      allocated.items.map((accepted) => {
        return accepted.identity.source;
      }),
    ).toStrictEqual(["calendar", "gmail", "chat"]);
  });

  it("skips one oversized item without ending that source's turns", () => {
    const oversized = item("gmail", "big", {
      body: "x".repeat(4096),
      priority: 0,
    });
    const small = item("gmail", "small", { body: "y", priority: 1 });
    const allocated = allocateMorningBriefRequest(
      [collection("gmail", [oversized, small])],
      { maxBytes: morningBriefItemBytes(small) + 10 },
    );

    expect(
      allocated.items.map((accepted) => {
        return accepted.identity.record;
      }),
    ).toStrictEqual(["small"]);
    expect(allocated.omittedBySource.gmail).toBe(1);
    expect(allocated.omittedBytes).toBe(morningBriefItemBytes(oversized));
  });

  it("counts an exactly fitting request as complete", () => {
    const only = item("slack", "m0", { body: "z".repeat(64) });
    // What the one item really adds to an empty array, measured rather than
    // charged: the first element pays no separator.
    const inRequest = morningBriefItemsBytes([only]) - 2;
    const allocated = allocateMorningBriefRequest(
      [collection("slack", [only])],
      { maxBytes: inRequest },
    );

    expect(allocated.omittedItems).toBe(0);
    expect(allocated.bytes).toBe(inRequest);
  });
});

describe("collection phase bounds", () => {
  const phaseStartedAt = new Date("2026-09-17T06:00:00.000Z");

  it("stops admitting reads at the cutoff, not at the phase deadline", () => {
    const atCutoff = new Date(
      phaseStartedAt.getTime() + MORNING_BRIEF_NEW_READ_CUTOFF_MS,
    );

    expect(
      morningBriefMayStartRead(
        phaseStartedAt,
        new Date(atCutoff.getTime() - 1),
      ),
    ).toBeTruthy();
    expect(morningBriefMayStartRead(phaseStartedAt, atCutoff)).toBeFalsy();
    expect(
      morningBriefMayStartRead(
        phaseStartedAt,
        new Date(
          phaseStartedAt.getTime() + MORNING_BRIEF_COLLECTION_PHASE_MS - 1,
        ),
      ),
    ).toBeFalsy();
  });

  it("gives a source zero budget once the cutoff has passed", () => {
    const budget = morningBriefSourceBudget(
      "slack",
      phaseStartedAt,
      new Date(phaseStartedAt.getTime() + MORNING_BRIEF_NEW_READ_CUTOFF_MS),
    );

    expect(budget.maxRequests).toBe(0);
    expect(budget.deadlineAt.getTime()).toBe(
      phaseStartedAt.getTime() + MORNING_BRIEF_NEW_READ_CUTOFF_MS,
    );
  });

  it("never lets a source ceiling outrun the remaining phase", () => {
    const at = new Date(phaseStartedAt.getTime() + 20_000);
    const budget = morningBriefSourceBudget("slack", phaseStartedAt, at);

    // Slack's own ceiling is 30s, but only 20s of the phase remain.
    expect(budget.deadlineAt.getTime()).toBe(
      phaseStartedAt.getTime() + MORNING_BRIEF_NEW_READ_CUTOFF_MS,
    );
  });

  it("is further bounded by the occurrence deadline", () => {
    const occurrenceDeadlineAt = new Date(phaseStartedAt.getTime() + 8000);
    const budget = morningBriefSourceBudget(
      "gmail",
      phaseStartedAt,
      phaseStartedAt,
      occurrenceDeadlineAt,
    );

    expect(budget.deadlineAt).toStrictEqual(occurrenceDeadlineAt);
  });

  it("starts at most three sources per wave in the fixed order", () => {
    expect(
      morningBriefSourceWaves(["chat", "slack", "github", "gmail", "calendar"]),
    ).toStrictEqual([
      ["calendar", "gmail", "github"],
      ["slack", "chat"],
    ]);
  });
});

describe("retained source authority", () => {
  const descriptor: MorningBriefRetainedSourceDescriptor = {
    source: "slack",
    connectionId: null,
    accountRef: "T123:U456",
    scopeDigest: morningBriefScopeDigest(["conversations.history"]),
    endpoints: [],
    membershipId: "orgmem_1",
    agentId: "agent_1",
    capturedAt: "2026-09-17T06:00:00.000Z",
    containers: ["C1"],
    contributed: true,
  };

  /** A connector-backed source proves a connection, an account and endpoints. */
  const gmailDescriptor: MorningBriefRetainedSourceDescriptor = {
    ...descriptor,
    source: "gmail",
    connectionId: "conn_1",
    accountRef: "owner@example.test",
    endpoints: ["https://gmail.googleapis.com/gmail/v1/users/me/messages"],
    containers: ["thread-1"],
  };

  it("digests an unchanged grant identically regardless of order", () => {
    expect(morningBriefScopeDigest(["b", "a", "a"])).toBe(
      morningBriefScopeDigest(["a", "b"]),
    );
    expect(morningBriefScopeDigest(["a"])).not.toBe(
      morningBriefScopeDigest(["a", "b"]),
    );
  });

  it("rejects a duplicate source rather than silently keeping one", () => {
    expect(
      boundMorningBriefDescriptors([descriptor, { ...descriptor }]),
    ).toStrictEqual({ kind: "rejected", reason: "duplicate-source" });
  });

  it("rejects an oversized account reference", () => {
    expect(
      boundMorningBriefDescriptors([
        { ...descriptor, accountRef: "a".repeat(129) },
      ]).kind,
    ).toBe("rejected");
  });

  it("rejects supplied material whose account was never proved", () => {
    // Null identity is "not observed", never "any account": a later check given
    // this descriptor would have nothing to ask the provider about.
    expect(
      boundMorningBriefDescriptors([{ ...gmailDescriptor, accountRef: null }]),
    ).toStrictEqual({ kind: "rejected", reason: "unproven-authority" });
    expect(
      boundMorningBriefDescriptors([
        { ...gmailDescriptor, connectionId: null },
      ]),
    ).toStrictEqual({ kind: "rejected", reason: "unproven-authority" });
    expect(
      boundMorningBriefDescriptors([{ ...gmailDescriptor, endpoints: [] }]),
    ).toStrictEqual({ kind: "rejected", reason: "unproven-authority" });
  });

  it("accepts an unproven source that supplied nothing", () => {
    // An unconfigured connector has no retained input, so there is nothing for
    // a later check to defend and no reason to fail the whole composition.
    expect(
      boundMorningBriefDescriptors([
        {
          ...gmailDescriptor,
          connectionId: null,
          accountRef: null,
          scopeDigest: "",
          endpoints: [],
          containers: [],
          contributed: false,
        },
      ]).kind,
    ).toBe("bounded");
  });

  it("revalidates supplied-but-uncited material and skips sources that supplied none", () => {
    const supplied = morningBriefSourcesToRevalidate([
      descriptor,
      { ...gmailDescriptor, contributed: false },
    ]);

    expect(
      supplied.map((entry) => {
        return entry.source;
      }),
    ).toStrictEqual(["slack"]);
  });

  it("retains descriptors through the linked outbox deadline past result expiry", () => {
    const reservedAt = new Date("2026-09-17T06:00:00.000Z");
    // A Chat commit one minute before the 24h result expiry creates the outbox
    // request then, so its original 15-minute deadline lands after expiry.
    const outboxCreatedAt = new Date(
      reservedAt.getTime() + MORNING_BRIEF_RESULT_RETENTION_MS - 60_000,
    );

    const retainUntil = morningBriefDescriptorRetainUntil(
      reservedAt,
      outboxCreatedAt,
    );

    expect(retainUntil.getTime() - reservedAt.getTime()).toBe(
      MORNING_BRIEF_RESULT_RETENTION_MS -
        60_000 +
        MORNING_BRIEF_OUTBOX_DEADLINE_MS,
    );
    expect(retainUntil.getTime() - reservedAt.getTime()).toBeLessThanOrEqual(
      MORNING_BRIEF_RESULT_RETENTION_MS + MORNING_BRIEF_OUTBOX_DEADLINE_MS,
    );
  });

  it("does not extend retention for an obligation that resolves early", () => {
    const reservedAt = new Date("2026-09-17T06:00:00.000Z");

    expect(
      morningBriefDescriptorRetainUntil(
        reservedAt,
        new Date(reservedAt.getTime() + 60_000),
      ).getTime() - reservedAt.getTime(),
    ).toBe(MORNING_BRIEF_RESULT_RETENTION_MS);
    expect(
      morningBriefDescriptorRetainUntil(reservedAt, null).getTime() -
        reservedAt.getTime(),
    ).toBe(MORNING_BRIEF_RESULT_RETENTION_MS);
  });
});

describe("language precedence", () => {
  it("keeps Agent instructions as the authority over a member locale", () => {
    const plan = planMorningBriefLanguage({
      instructions: { state: "available", versionId: "ver_1", digest: "d1" },
      memberLocale: "en-US",
    });

    expect(plan.authority).toBe("agent-instructions");
    expect(plan.instructions).toStrictEqual({
      state: "available",
      versionId: "ver_1",
      digest: "d1",
    });
    // The same call applies the fallback only when the text says nothing.
    expect(plan.fallbackLanguage).toBe("en-US");
  });

  it("uses the member locale when no instructions exist", () => {
    const plan = planMorningBriefLanguage({
      instructions: { state: "no-storage", versionId: null },
      memberLocale: "ja-JP",
    });

    expect(plan.authority).toBe("member-locale");
    expect(plan.fallbackLanguage).toBe("ja-JP");
    expect(plan.instructions).toStrictEqual({
      state: "no-storage",
      versionId: null,
    });
  });

  it("keeps the version a proven absence was read under", () => {
    // An empty file and a version without the target are answers *from* a
    // configuration, so the plan says which one it read rather than dropping
    // the evidence that anything was read at all.
    expect(
      planMorningBriefLanguage({
        instructions: { state: "empty-file", versionId: "ver_9" },
        memberLocale: "ja-JP",
      }).instructions,
    ).toStrictEqual({ state: "empty-file", versionId: "ver_9" });
    expect(
      planMorningBriefLanguage({
        instructions: { state: "no-target", versionId: "ver_9" },
        memberLocale: null,
      }),
    ).toStrictEqual({
      authority: "default",
      fallbackLanguage: MORNING_BRIEF_DEFAULT_LANGUAGE,
      instructions: { state: "no-target", versionId: "ver_9" },
    });
  });

  it("falls back to the declared default for an absent or unknown locale", () => {
    expect(
      planMorningBriefLanguage({
        instructions: { state: "no-storage", versionId: null },
        memberLocale: null,
      }).authority,
    ).toBe("default");
    expect(
      planMorningBriefLanguage({
        instructions: { state: "no-storage", versionId: null },
        memberLocale: "xx-YY",
      }).fallbackLanguage,
    ).toBe(MORNING_BRIEF_DEFAULT_LANGUAGE);
  });

  it("represents Chinese independently of the UI locale enumeration", () => {
    expect(isMorningBriefOutputLanguage("zh-Hans")).toBeTruthy();
    expect(isMorningBriefOutputLanguage("zh-Hant")).toBeTruthy();
    // Settings still offers exactly the ten UI locales; neither is one of them.
    expect(
      planMorningBriefLanguage({
        instructions: { state: "no-storage", versionId: null },
        memberLocale: "zh-Hans",
      }).authority,
    ).toBe("member-locale");
  });

  it("records a reported language only when it is one this pipeline knows", () => {
    expect(validateReportedLanguage(" zh-Hant ")).toBe("zh-Hant");
    expect(validateReportedLanguage("zh")).toBeNull();
    expect(validateReportedLanguage(null)).toBeNull();
    expect(validateReportedLanguage(undefined)).toBeNull();
  });
});

describe("slack normalization", () => {
  it("keeps the exact fractional timestamp as the record identity", () => {
    const normalized = normalizeMorningBriefSlack(bundleFixture(), {
      workspaceId: "T123",
      slackUserId: "U456",
    });

    expect(normalized.items[0]?.identity).toStrictEqual({
      source: "slack",
      account: "T123:U456",
      container: "C1",
      record: "1789000600.000200",
      instance: "1789000000.000100",
    });
    expect(normalized.coverage).toBe("complete");
  });

  it("ranks newest first and emits only program-resolved links", () => {
    const normalized = normalizeMorningBriefSlack(bundleFixture(), {
      workspaceId: "T123",
      slackUserId: "U456",
    });

    expect(
      normalized.items.map((entry) => {
        return entry.body;
      }),
    ).toStrictEqual(["newer reply", "older"]);
    expect(normalized.items[0]?.links).toStrictEqual([
      { label: "#general", url: "https://example.slack.com/archives/C1" },
    ]);
  });

  it("reports a healthy empty read as empty, not as complete", () => {
    const normalized = normalizeMorningBriefSlack(
      { ...bundleFixture(), entries: [], coverage: "empty" },
      { workspaceId: "T123", slackUserId: "U456" },
    );

    expect(normalized.coverage).toBe("empty");
    expect(normalized.items).toHaveLength(0);
  });
});

describe("exact request bytes", () => {
  it("charges what the serialized array actually costs, escaping included", () => {
    // Quote characters are the case the old estimator got wrong: each one
    // becomes two bytes once escaped, so summing raw field lengths reported
    // roughly half the true size.
    const quoted = Array.from({ length: 32 }, (_, index) => {
      return item("slack", `m${index.toString()}`, {
        body: '"'.repeat(4096),
        priority: index,
      });
    });

    const summed = quoted.reduce((total, entry) => {
      return total + morningBriefItemBytes(entry);
    }, 0);
    // What the items actually add to a request: the array's own brackets are
    // already in the envelope, so the delta is the elements and separators.
    const inRequest = morningBriefItemsBytes(quoted) - 2;

    // The charge must cover what the request really spends, never undercount.
    expect(summed).toBeGreaterThanOrEqual(inRequest);
    // And it must not be wildly conservative: one separator byte per item.
    expect(summed - inRequest).toBeLessThanOrEqual(quoted.length);
    // The old field-sum estimator reported roughly half of this for the same
    // input, which is the defect these bounds exist to prevent.
    expect(summed).toBeGreaterThan(quoted.length * 4096);
  });

  it("counts control characters and non-ASCII at their escaped width", () => {
    const controls = item("gmail", "m0", { body: "\u0001\u0002" });
    const chinese = item("gmail", "m1", { body: "早安简报" });

    expect(morningBriefItemBytes(controls)).toBe(
      Buffer.byteLength(JSON.stringify(serializeForTest(controls)), "utf8") + 1,
    );
    // Four Chinese characters are 12 UTF-8 bytes, not four.
    expect(morningBriefItemBytes(chinese)).toBeGreaterThan(
      morningBriefItemBytes(item("gmail", "m1", { body: "abcd" })),
    );
  });

  it("keeps the assembled request inside the ceiling it was budgeted against", () => {
    const language = planMorningBriefLanguage({
      instructions: { state: "no-storage", versionId: null },
      memberLocale: "en-US",
    });
    const items = Array.from({ length: 200 }, (_, index) => {
      return item("gmail", `m${index.toString()}`, {
        body: "e".repeat(900),
        priority: index,
      });
    });
    const collections = [collection("gmail", items)];
    const envelopeBytes = morningBriefEnvelopeBytes({
      language,
      instructions: null,
      coverage: morningBriefCoverageReport(collections, {
        byNormalizedCap: {},
        byRequest: {},
      }),
    });

    const allocated = allocateMorningBriefRequest(collections, {
      overheadBytes: envelopeBytes,
    });
    const request = buildMorningBriefRequest({
      language,
      instructions: null,
      coverage: morningBriefCoverageReport(collections, {
        byNormalizedCap: {},
        byRequest: allocated.omittedBySource,
      }),
      items: allocated.items,
    });

    expect(allocated.omittedItems).toBeGreaterThan(0);
    expect(morningBriefRequestBytes(request)).toBeLessThanOrEqual(
      MORNING_BRIEF_REQUEST_MAX_BYTES,
    );
  });

  it("reserves the whole instruction file before allocating evidence", () => {
    const language = planMorningBriefLanguage({
      instructions: { state: "available", versionId: "ver_1", digest: "d1" },
      memberLocale: null,
    });
    const instructions = "写成简体中文。".repeat(4096);
    const coverage = morningBriefCoverageReport([], {
      byNormalizedCap: {},
      byRequest: {},
    });

    const withText = morningBriefEnvelopeBytes({
      language,
      instructions,
      coverage,
    });
    const withoutText = morningBriefEnvelopeBytes({
      language,
      instructions: null,
      coverage,
    });

    // The field changes from `null` to a quoted string, so the growth is the
    // whole text plus two quotes minus the four bytes `null` occupied.
    expect(withText - withoutText).toBe(
      Buffer.byteLength(instructions, "utf8") + 2 - 4,
    );
  });
});

describe("first-round source fairness under a tight ceiling", () => {
  it("leaves room for a later source's first item", () => {
    // Gmail's first item alone would fit the whole budget; without a reserve it
    // would take it, and Slack would contribute nothing at all.
    const gmail = [item("gmail", "big", { body: "g".repeat(600) })];
    const slack = [item("slack", "small", { body: "s" })];
    // One byte short of what both items really cost in the request array.
    const budget =
      morningBriefItemsBytes([
        gmail[0] as MorningBriefSourceItem,
        slack[0] as MorningBriefSourceItem,
      ]) -
      2 -
      1;

    const allocated = allocateMorningBriefRequest(
      [collection("gmail", gmail), collection("slack", slack)],
      { maxBytes: budget },
    );

    expect(
      allocated.items.map((accepted) => {
        return accepted.identity.source;
      }),
    ).toStrictEqual(["slack"]);
    expect(allocated.omittedBySource.gmail).toBe(1);
  });

  it("still admits both when the budget covers both first items exactly", () => {
    const gmail = [item("gmail", "g0", { body: "g".repeat(600) })];
    const slack = [item("slack", "s0", { body: "s" })];
    // Exactly what both items cost in the request array, measured not summed.
    const budget =
      morningBriefItemsBytes([
        gmail[0] as MorningBriefSourceItem,
        slack[0] as MorningBriefSourceItem,
      ]) - 2;

    const allocated = allocateMorningBriefRequest(
      [collection("gmail", gmail), collection("slack", slack)],
      { maxBytes: budget },
    );

    expect(allocated.items).toHaveLength(2);
    expect(allocated.omittedItems).toBe(0);
  });
});

describe("truncation provenance", () => {
  it("marks a clipped Slack message so the request cannot read it as whole", () => {
    const normalized = normalizeMorningBriefSlack(bundleFixture(), {
      workspaceId: "T123",
      slackUserId: "U456",
    });

    expect(normalized.items[0]?.truncated).toBeTruthy();
    expect(normalized.items[1]?.truncated).toBeFalsy();
    expect(
      JSON.stringify(
        serializeForTest(normalized.items[0] as MorningBriefSourceItem),
      ),
    ).toContain('"truncated":true');
  });
});
describe("declared bounds", () => {
  it("pins the documented collection and request ceilings", () => {
    expect(MORNING_BRIEF_COLLECTION_PHASE_MS).toBe(45_000);
    expect(MORNING_BRIEF_FINAL_CHECK_RESERVE_MS).toBe(5000);
    expect(MORNING_BRIEF_NEW_READ_CUTOFF_MS).toBe(40_000);
    expect(MORNING_BRIEF_MAX_CONCURRENT_SOURCES).toBe(3);
    expect(MORNING_BRIEF_REQUEST_MAX_BYTES).toBe(128 * 1024);
    expect(MORNING_BRIEF_COMBINED_NORMALIZED_MAX_BYTES).toBe(1024 * 1024);
  });

  it("keeps each source's own ceiling rather than one shared number", () => {
    expect(MORNING_BRIEF_SOURCE_BUDGETS).toStrictEqual({
      gmail: { deadlineMs: 20_000, maxRequests: 44 },
      calendar: { deadlineMs: 20_000, maxRequests: 18 },
      github: { deadlineMs: 20_000, maxRequests: 24 },
      // Slack's ceiling is the collector's own declared deadline.
      slack: { deadlineMs: 30_000, maxRequests: 40 },
      chat: { deadlineMs: 15_000, maxRequests: 0 },
    });
  });

  it("pins the bounded language-context storage reads", () => {
    expect(MORNING_BRIEF_MANIFEST_MAX_BYTES).toBe(256 * 1024);
    expect(MORNING_BRIEF_ARCHIVE_MAX_BYTES).toBe(1024 * 1024);
    expect(MORNING_BRIEF_ARCHIVE_MAX_DECOMPRESSED_BYTES).toBe(2 * 1024 * 1024);
    expect(MORNING_BRIEF_INSTRUCTIONS_MAX_BYTES).toBe(64 * 1024);
    expect(MORNING_BRIEF_STORAGE_PHASE_MS).toBe(5000);
  });

  it("selects one language deadline and admits only positive timer time", () => {
    const expiresAt = 5000;

    expect(morningBriefStoragePhaseExpiresAt(0, 45_000)).toBe(5000);
    expect(morningBriefStoragePhaseExpiresAt(44_000, 45_000)).toBe(45_000);
    expect(morningBriefStoragePhaseRemainingMs(45_000, 44_000)).toBe(1000);
    expect(morningBriefStoragePhaseExpiresAt(45_000, 45_000)).toBe(45_000);
    expect(morningBriefStoragePhaseRemainingMs(45_000, 45_000)).toBeNull();
    expect(morningBriefStoragePhaseExpired(expiresAt, 4999)).toBeFalsy();
    expect(morningBriefStoragePhaseRemainingMs(expiresAt, 4999)).toBe(1);
    expect(morningBriefStoragePhaseExpired(expiresAt, 5000)).toBeTruthy();
    expect(morningBriefStoragePhaseRemainingMs(expiresAt, 5000)).toBeNull();
    expect(morningBriefStoragePhaseExpired(expiresAt, 5010)).toBeTruthy();
    expect(morningBriefStoragePhaseRemainingMs(expiresAt, 5010)).toBeNull();
  });

  it("pins the retained descriptor bounds", () => {
    expect(MORNING_BRIEF_MAX_RETAINED_DESCRIPTORS).toBe(5);
    expect(MORNING_BRIEF_DESCRIPTOR_MAX_BYTES).toBe(2048);
    expect(MORNING_BRIEF_DESCRIPTOR_SET_MAX_BYTES).toBe(8192);
    expect(MORNING_BRIEF_ACCOUNT_REF_MAX_BYTES).toBe(128);
  });

  it("offers Chinese beyond the ten UI locales and digests the read surface", () => {
    expect(MORNING_BRIEF_OUTPUT_LANGUAGES).toHaveLength(12);
    expect(MORNING_BRIEF_SLACK_READ_SURFACE).toStrictEqual([
      "users.conversations",
      "conversations.history",
      "conversations.replies",
    ]);
  });
});

describe("request packing against the final report", () => {
  const language = planMorningBriefLanguage({
    instructions: { state: "no-storage", versionId: null },
    memberLocale: null,
  });

  it("repacks when included and omitted counts cross different digit boundaries", () => {
    // This is the concrete count-width counterexample: with 40 records, the
    // final included=20/omitted=20 report is one byte wider than the synthetic
    // included=0/omitted=40 extreme used by the old reservation.
    const items = Array.from({ length: 40 }, (_, index) => {
      return item("slack", `m${index.toString()}`, {
        body: '"'.repeat(1500),
        priority: index,
      });
    });
    const collections = [collection("slack", items)];
    const packed = packMorningBriefRequest({
      collections,
      language,
      instructions: "i".repeat(59_856),
      omittedByNormalizedCap: {},
    });

    expect(packed.allocation.omittedItems).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(packed.request), "utf8")).toBe(
      packed.totalBytes,
    );
    expect(packed.totalBytes).toBeLessThanOrEqual(
      MORNING_BRIEF_REQUEST_MAX_BYTES,
    );
  });

  it("reports composed source and normalized omissions in the packed document", () => {
    const items = Array.from({ length: 400 }, (_, index) => {
      return item("gmail", `m${index.toString()}`, {
        body: "e".repeat(400),
        priority: index,
      });
    });
    const collections = [
      {
        ...collection("gmail", items),
        omittedBySource: { known: 17, unknownRemaining: true },
      },
    ];
    const packed = packMorningBriefRequest({
      collections,
      language,
      instructions: null,
      omittedByNormalizedCap: { gmail: 9 },
    });

    expect(packed.allocation.omittedItems).toBeGreaterThan(99);
    expect(packed.totalBytes).toBeLessThanOrEqual(
      MORNING_BRIEF_REQUEST_MAX_BYTES,
    );
    const [report] = packed.request.coverage;
    expect(report?.omitted.bySource.known).toBe(17);
    expect(report?.omitted.byNormalizedCap).toBe(9);
    expect(report?.omitted.byRequest).toBe(packed.allocation.omittedItems);
    expect(report?.omitted.unknownRemaining).toBeTruthy();
  });
});

describe("five-source normalization", () => {
  it("keeps an all-day calendar event as a date with an exclusive end", () => {
    const normalized = normalizeMorningBriefCalendar(
      {
        source: "google-calendar",
        status: "ok",
        anchor: "2026-11-01T20:00:00.000Z",
        collectedAt: "2026-11-01T20:00:00.000Z",
        timezone: "America/Los_Angeles",
        window: {
          startAt: "2026-11-01T07:00:00.000Z",
          endAt: "2026-11-02T08:00:00.000Z",
          startDate: "2026-11-01",
          endDateExclusive: "2026-11-02",
        },
        items: [
          {
            calendarId: "cal-1",
            calendarSummary: "Work",
            calendarTimezone: "America/Los_Angeles",
            eventId: "evt-1",
            iCalUID: null,
            recurringEventId: null,
            originalStartTime: null,
            summary: "Offsite",
            location: null,
            descriptionExcerpt: null,
            allDay: true,
            start: "2026-11-01",
            end: "2026-11-02",
            eventTimezone: null,
            localDayOffset: 0,
            organizer: null,
            selfResponseStatus: null,
            attendees: [],
            attendeesTruncated: false,
            link: "https://calendar.google.com/event?eid=1",
          },
        ],
        coverage: {
          calendarList: "complete",
          calendars: [],
          truncations: [],
          requests: 1,
          retryAfterMs: null,
        },
        failure: null,
      },
      "member-1",
    );

    const [only] = normalized.items;
    expect(only?.timeSemantics).toBe("date-only");
    // The exclusive end survives as a calendar date. No UTC midnight is
    // fabricated into either model-visible instant field, including across the
    // 25-hour fall-back day in America/Los_Angeles.
    expect(only?.occurredAt).toBeNull();
    expect(only?.endsAt).toBeNull();
    expect(only?.dateRange).toStrictEqual({
      startDate: "2026-11-01",
      endDateExclusive: "2026-11-02",
      timezone: "America/Los_Angeles",
    });
    const serialized = serializeForTest(only as MorningBriefSourceItem);
    expect(serialized.time).toStrictEqual({
      kind: "date-only",
      startDate: "2026-11-01",
      endDateExclusive: "2026-11-02",
      timezone: "America/Los_Angeles",
    });
    expect(JSON.stringify(serialized)).not.toContain("T00:00:00.000Z");
    expect(only?.identity.container).toBe("cal-1");
  });

  it("keeps two occurrences of one recurring series apart", () => {
    const base = {
      calendarId: "cal-1",
      calendarSummary: null,
      calendarTimezone: null,
      eventId: "evt-series",
      iCalUID: null,
      recurringEventId: "evt-series",
      summary: "Standup",
      location: null,
      descriptionExcerpt: null,
      allDay: false,
      eventTimezone: null,
      localDayOffset: 0,
      organizer: null,
      selfResponseStatus: null,
      attendees: [],
      attendeesTruncated: false,
      link: null,
    };
    const normalized = normalizeMorningBriefCalendar(
      {
        source: "google-calendar",
        status: "ok",
        anchor: "2026-09-17T06:00:00.000Z",
        collectedAt: "2026-09-17T06:00:00.000Z",
        timezone: "UTC",
        window: {
          startAt: "2026-09-16T16:00:00.000Z",
          endAt: "2026-09-17T16:00:00.000Z",
          startDate: "2026-09-17",
          endDateExclusive: "2026-09-18",
        },
        items: [
          {
            ...base,
            originalStartTime: "2026-09-17T01:00:00Z",
            start: "2026-09-17T01:00:00Z",
            end: "2026-09-17T01:15:00Z",
          },
          {
            ...base,
            originalStartTime: "2026-09-18T01:00:00Z",
            start: "2026-09-18T01:00:00Z",
            end: "2026-09-18T01:15:00Z",
          },
        ],
        coverage: {
          calendarList: "complete",
          calendars: [],
          truncations: [],
          requests: 1,
          retryAfterMs: null,
        },
        failure: null,
      },
      "member-1",
    );

    expect(dedupeMorningBriefItems(normalized.items)).toHaveLength(2);
  });

  it("reports outstanding GitHub work as backlog, not as window activity", () => {
    const normalized = normalizeMorningBriefGithub({
      source: "github",
      login: "octocat",
      anchor: "2026-09-17T06:00:00.000Z",
      collectedAt: "2026-09-17T06:00:00.000Z",
      observedAt: "2026-09-17T06:00:00.000Z",
      timezone: "UTC",
      coverage: "complete",
      outcome: "complete",
      items: [
        {
          repository: "vm0-ai/okou",
          number: 12,
          kind: "issue",
          title: "Stale issue",
          state: "open",
          updatedAt: "2026-09-01T00:00:00.000Z",
          reasons: [{ branch: "assigned" }],
        },
        {
          repository: "vm0-ai/okou",
          number: 12,
          kind: "pull-request",
          title: "Fresh notification",
          state: "open",
          updatedAt: "2026-09-17T05:00:00.000Z",
          reasons: [{ branch: "notification" }],
        },
      ],
      branches: {
        notifications: {
          status: "complete" as const,
          pages: 1,
          items: 1,
          limits: [],
        },
        assigned: {
          status: "complete" as const,
          pages: 1,
          items: 1,
          limits: [],
        },
        reviewRequested: {
          status: "complete" as const,
          pages: 1,
          items: 1,
          limits: [],
        },
        checks: { status: "complete" as const, pages: 1, items: 1, limits: [] },
      },
      limits: [],
      counts: { items: 2, requests: 4, textCharacters: 24 },
    });

    // Window activity leads, and a week-old assignment is not "this morning".
    expect(normalized.items[0]?.timeSemantics).toBe("instant");
    expect(normalized.items[1]?.timeSemantics).toBe("outstanding");
    // Issue #12 and pull request #12 are two records, not one.
    expect(dedupeMorningBriefItems(normalized.items)).toHaveLength(2);
    expect(normalized.items[0]?.identity.account).toBe("octocat");
  });

  it("treats unread Chat as standing state and emits no invented link", () => {
    const normalized = normalizeMorningBriefChat(
      {
        source: "chat",
        anchor: "2026-09-17T06:00:00.000Z",
        collectedAt: "2026-09-17T06:00:00.000Z",
        result: "collected",
        coverage: "complete",
        scope: { unreadCandidates: 1, inspectedThreads: 1 },
        items: [
          {
            threadId: "11111111-1111-4111-8111-111111111111",
            agentId: "22222222-2222-4222-8222-222222222222",
            provenance: "ordinary",
            terminal: {
              eventId: "33333333-3333-4333-8333-333333333333",
              runId: "44444444-4444-4444-8444-444444444444",
              seqId: 9,
              at: "2026-09-16T10:00:00.000Z",
            },
            excerpts: [
              {
                eventId: "33333333-3333-4333-8333-333333333333",
                seqId: 9,
                role: "assistant",
                at: "2026-09-16T10:00:00.000Z",
                text: "the migration finished",
              },
            ],
            truncations: [],
          },
        ],
        skipped: [],
        truncations: [],
      },
      "member-1",
    );

    const [only] = normalized.items;
    expect(only?.timeSemantics).toBe("outstanding");
    // The reader exposes no thread URL, so none is fabricated.
    expect(only?.links).toStrictEqual([]);
    expect(only?.body).toContain("the migration finished");
  });

  it("allocates fairly across all five sources in the fixed order", () => {
    const collections = MORNING_BRIEF_SOURCE_ORDER.map((source) => {
      return collection(source, [
        item(source, `${source}-0`, { body: "x".repeat(400) }),
        item(source, `${source}-1`, { body: "y".repeat(400), priority: 1 }),
      ]);
    });
    // Exactly enough for one item from each source and nothing more, measured
    // on the array those five items actually serialize to.
    const budget =
      morningBriefItemsBytes(
        collections.map((entry) => {
          return entry.items[0] as MorningBriefSourceItem;
        }),
      ) - 2;

    const allocated = allocateMorningBriefRequest(collections, {
      maxBytes: budget,
    });

    expect(
      allocated.items.map((accepted) => {
        return accepted.identity.source;
      }),
    ).toStrictEqual([...MORNING_BRIEF_SOURCE_ORDER]);
    expect(allocated.omittedItems).toBe(5);
  });

  it("starts five configured sources in two joined waves of at most three", () => {
    expect(
      morningBriefSourceWaves([...MORNING_BRIEF_SOURCE_ORDER]),
    ).toStrictEqual([
      ["calendar", "gmail", "github"],
      ["slack", "chat"],
    ]);
  });
});

describe("allocation under an unsatisfiable reservation", () => {
  it("admits a fitting early item when a later source could never fit", () => {
    // The controller's counterexample: a small Calendar item and an oversized
    // Chat item share a tight ceiling. Reserving for Chat's first item — which
    // no allocation could ever place — used to drop Calendar too, and the
    // attempt then reported that nothing fitted while holding something that
    // did.
    const calendar = item("calendar", "e0", { body: "c".repeat(120) });
    const chat = item("chat", "c0", { body: "x".repeat(40_000) });
    const capacity = 1000;
    expect(morningBriefItemBytes(calendar)).toBeLessThan(capacity);
    expect(morningBriefItemBytes(chat)).toBeGreaterThan(capacity);

    const allocated = allocateMorningBriefRequest(
      [collection("calendar", [calendar]), collection("chat", [chat])],
      { maxBytes: capacity },
    );

    expect(
      allocated.items.map((accepted) => {
        return accepted.identity.record;
      }),
    ).toStrictEqual(["e0"]);
    expect(allocated.omittedBySource.chat).toBe(1);
    expect(allocated.omittedBySource.calendar).toBeUndefined();
    // Measured independently of the allocator's own counter.
    expect(morningBriefItemsBytes(allocated.items) - 2).toBeLessThanOrEqual(
      capacity,
    );
  });

  it("keeps filling from a source whose own first item could never fit", () => {
    const calendar = item("calendar", "e0", { body: "c".repeat(120) });
    const hugeChat = item("chat", "c-huge", {
      body: "x".repeat(40_000),
      priority: 0,
    });
    const smallChat = item("chat", "c-small", { body: "y", priority: 1 });
    // Exactly enough for the two items that can fit, and nothing more.
    const capacity = morningBriefItemsBytes([calendar, smallChat]) - 2;
    expect(morningBriefItemBytes(hugeChat)).toBeGreaterThan(capacity);

    const allocated = allocateMorningBriefRequest(
      [
        collection("calendar", [calendar]),
        collection("chat", [hugeChat, smallChat]),
      ],
      { maxBytes: capacity },
    );

    expect(
      allocated.items.map((accepted) => {
        return accepted.identity.record;
      }),
    ).toStrictEqual(["e0", "c-small"]);
    expect(allocated.omittedItems).toBe(1);
    expect(allocated.omittedBytes).toBe(morningBriefItemBytes(hugeChat));
  });

  it("represents every source that fits and no source that cannot", () => {
    const fitting = MORNING_BRIEF_SOURCE_ORDER.filter((source) => {
      return source !== "chat";
    }).map((source) => {
      return collection(source, [
        item(source, `${source}-0`, { body: "s".repeat(80) }),
        item(source, `${source}-1`, { body: "t".repeat(80), priority: 1 }),
      ]);
    });
    const firstItems = fitting.map((entry) => {
      return entry.items[0] as MorningBriefSourceItem;
    });

    const allocated = allocateMorningBriefRequest(
      [
        ...fitting,
        collection("chat", [
          item("chat", "chat-huge", { body: "z".repeat(40_000) }),
        ]),
      ],
      { maxBytes: morningBriefItemsBytes(firstItems) - 2 },
    );

    expect(
      allocated.items.map((accepted) => {
        return accepted.identity.source;
      }),
    ).toStrictEqual(["calendar", "gmail", "github", "slack"]);
    expect(allocated.omittedBySource.chat).toBe(1);
  });
});

describe("request ceiling measured on the consumed serialization", () => {
  const language = planMorningBriefLanguage({
    instructions: { state: "available", versionId: "ver_1", digest: "d1" },
    memberLocale: null,
  });
  const instructions = "i".repeat(59_856);

  function assemble(
    collections: readonly MorningBriefSourceCollection[],
    items: readonly MorningBriefSourceItem[],
    byRequest: Partial<Record<MorningBriefSourceKind, number>>,
  ) {
    return buildMorningBriefRequest({
      language,
      instructions,
      coverage: morningBriefCoverageReport(collections, {
        byNormalizedCap: {},
        byRequest,
      }),
      items,
    });
  }

  it("meets the actual 128 KiB ceiling exactly and drops a whole item one byte under", () => {
    // Full instruction text, escaping, non-ASCII and control characters all
    // share the same consumed serialization. ASCII padding then lands that
    // independent oracle exactly on the production ceiling.
    const prefix = '"早安"\u0001'.repeat(64);
    const baseItem = item("gmail", "m0", {
      body: prefix,
      facts: morningBriefItemFacts({
        reasons: [
          { branch: "recent", detail: null, unread: true },
          { branch: "unread", detail: null, unread: true },
        ],
        bodySource: "text-plain",
      }),
    });
    const baseCollections = [collection("gmail", [baseItem])];
    const baseBytes = Buffer.byteLength(
      JSON.stringify(assemble(baseCollections, [baseItem], {})),
      "utf8",
    );
    const only = {
      ...baseItem,
      body: prefix + "x".repeat(MORNING_BRIEF_REQUEST_MAX_BYTES - baseBytes),
    };
    const collections = [collection("gmail", [only])];
    const oracle = Buffer.byteLength(
      JSON.stringify(assemble(collections, [only], {})),
      "utf8",
    );
    expect(oracle).toBe(MORNING_BRIEF_REQUEST_MAX_BYTES);

    const fitted = packMorningBriefRequest({
      collections,
      language,
      instructions,
      omittedByNormalizedCap: {},
    });
    expect(fitted.allocation.items).toHaveLength(1);
    expect(fitted.totalBytes).toBe(MORNING_BRIEF_REQUEST_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(fitted.request), "utf8")).toBe(
      fitted.totalBytes,
    );

    const overflowed = packMorningBriefRequest({
      collections,
      language,
      instructions,
      omittedByNormalizedCap: {},
      maxBytes: MORNING_BRIEF_REQUEST_MAX_BYTES - 1,
    });
    expect(overflowed.allocation.items).toHaveLength(0);
    expect(overflowed.allocation.omittedBySource.gmail).toBe(1);
    expect(overflowed.totalBytes).toBeLessThanOrEqual(
      MORNING_BRIEF_REQUEST_MAX_BYTES - 1,
    );
  });

  it("reports every stage that reduced a source, not only the last one", () => {
    const kept = item("slack", "s0", { body: "k", priority: 0 });
    const droppedByCap = item("slack", "s1", { body: "d", priority: 1 });
    const unknownRemaining = { known: 0, unknownRemaining: true };
    const bounded = boundCombinedNormalizedItems(
      [
        {
          ...collection("slack", [kept, droppedByCap]),
          omittedBySource: unknownRemaining,
        },
      ],
      aggregateOracle([
        {
          ...collection("slack", [kept]),
          coverage: "partial" as const,
          omittedBySource: unknownRemaining,
        },
      ]),
    );
    const [report] = morningBriefCoverageReport(bounded.collections, {
      byNormalizedCap: bounded.omittedBySource,
      byRequest: {},
    });

    expect(report?.included).toBe(1);
    expect(report?.omitted.byNormalizedCap).toBe(1);
    expect(report?.omitted.knownTotal).toBe(1);
    // A cap that ended the provider read stays an explicit unknown, never a
    // count the collector never made.
    expect(report?.omitted.unknownRemaining).toBeTruthy();
  });
});

describe("preserved provider facts", () => {
  function githubBundle(record: {
    readonly branch: "assigned" | "review-requested";
    readonly headSha: string;
    readonly state: "failing" | "success";
  }): MorningBriefGithubBundle {
    return {
      source: "github" as const,
      login: "octocat",
      anchor: "2026-09-17T06:00:00.000Z",
      collectedAt: "2026-09-17T06:00:00.000Z",
      observedAt: "2026-09-17T06:00:00.000Z",
      timezone: "UTC",
      coverage: "complete" as const,
      outcome: "complete" as const,
      items: [
        {
          repository: "vm0-ai/okou",
          number: 7,
          kind: "pull-request" as const,
          title: "Ship the composition",
          state: "open" as const,
          updatedAt: "2026-09-17T05:00:00.000Z",
          reasons: [{ branch: record.branch }],
          checks: {
            headSha: record.headSha,
            state: record.state,
            failing: record.state === "failing" ? 1 : 0,
            pending: 0,
            succeeded: 1,
            failingNames: record.state === "failing" ? ["build"] : [],
            incomplete: false,
          },
        },
      ],
      branches: {
        notifications: {
          status: "complete" as const,
          windowStart: "2026-09-16T06:00:00.000Z",
          windowEnd: "2026-09-17T06:00:00.000Z",
          pages: 1,
          items: 0,
          limits: [],
        },
        assigned: {
          status: "complete" as const,
          observedAt: "2026-09-17T06:00:00.000Z",
          pages: 1,
          items: 1,
          limits: [],
        },
        reviewRequested: {
          status: "complete" as const,
          observedAt: "2026-09-17T06:00:00.000Z",
          pages: 1,
          items: 1,
          limits: [],
        },
        checks: { status: "complete" as const, pages: 2, items: 1, limits: [] },
      },
      limits: [],
      counts: { items: 1, requests: 9, textCharacters: 24 },
    };
  }

  it("distinguishes one pull request selected by different branches", () => {
    const reviewRequested = normalizeMorningBriefGithub(
      githubBundle({
        branch: "review-requested",
        headSha: "a".repeat(40),
        state: "failing",
      }),
    );
    const assigned = normalizeMorningBriefGithub(
      githubBundle({
        branch: "assigned",
        headSha: "b".repeat(40),
        state: "success",
      }),
    );

    // Same repository, number and title; two different obligations.
    expect(reviewRequested.items[0]?.title).toBe(assigned.items[0]?.title);
    expect(morningBriefEvidenceDigest(reviewRequested.items)).not.toBe(
      morningBriefEvidenceDigest(assigned.items),
    );
    expect(reviewRequested.items[0]?.facts.checks?.headSha).toBe(
      "a".repeat(40),
    );
    expect(reviewRequested.items[0]?.facts.checks?.failingNames).toStrictEqual([
      "build",
    ]);
    expect(reviewRequested.items[0]?.facts.reasons).toStrictEqual([
      { branch: "review-requested", detail: null, unread: null },
    ]);
    // The collector's own read count, not a sum of list pages.
    expect(reviewRequested.requests).toBe(9);
  });

  it("keeps both Gmail branches and the unread snapshot time", () => {
    const normalized = normalizeMorningBriefGmail(
      {
        source: "gmail",
        status: "partial",
        accountEmail: "owner@example.test",
        anchor: "2026-09-17T06:00:00.000Z",
        collectedAt: "2026-09-17T06:00:10.000Z",
        timezone: "Asia/Shanghai",
        recentWindow: {
          from: "2026-09-16T06:00:00.000Z",
          to: "2026-09-17T06:00:00.000Z",
        },
        unreadObservedAt: "2026-09-17T06:00:05.000Z",
        items: [
          {
            messageId: "m1",
            threadId: "t1",
            branches: ["recent", "unread"],
            subject: "Release",
            from: "peer@example.test",
            to: null,
            date: "Wed, 16 Sep 2026 20:00:00 +0000",
            internalDate: "2026-09-16T20:00:00.000Z",
            unread: true,
            excerpt: "text",
            excerptSource: "text-plain",
            sourceUrl: "https://mail.google.com/mail/u/0/#inbox/m1",
          },
        ],
        coverage: {
          recent: "truncated",
          unread: "complete",
          truncations: ["list-pages", "candidates"],
          requests: 6,
          retryAfterMs: null,
        },
        failure: null,
      },
      "owner@example.test",
    );

    expect(normalized.items[0]?.facts.reasons).toStrictEqual([
      { branch: "recent", detail: null, unread: true },
      { branch: "unread", detail: null, unread: true },
    ]);
    expect(normalized.provenance.observedAt).toBe("2026-09-17T06:00:05.000Z");
    expect(normalized.provenance.startAt).toBe("2026-09-16T06:00:00.000Z");
    // Two truncation kinds are not two messages: the count stays unknown.
    expect(normalized.omittedBySource).toStrictEqual({
      known: 0,
      unknownRemaining: true,
    });
  });

  it("keeps an all-day date, its timezone and the frozen local window", () => {
    const normalized = normalizeMorningBriefCalendar(
      {
        source: "google-calendar",
        status: "ok",
        anchor: "2026-09-17T06:00:00.000Z",
        collectedAt: "2026-09-17T06:00:00.000Z",
        timezone: "Asia/Shanghai",
        window: {
          startAt: "2026-09-16T16:00:00.000Z",
          endAt: "2026-09-17T16:00:00.000Z",
          startDate: "2026-09-17",
          endDateExclusive: "2026-09-18",
        },
        items: [
          {
            calendarId: "cal-1",
            calendarSummary: "Work",
            calendarTimezone: "America/Los_Angeles",
            eventId: "evt-1",
            iCalUID: null,
            recurringEventId: null,
            originalStartTime: null,
            summary: "Offsite",
            location: null,
            descriptionExcerpt: null,
            allDay: true,
            start: "2026-09-17",
            end: "2026-09-19",
            eventTimezone: null,
            localDayOffset: 0,
            organizer: null,
            selfResponseStatus: null,
            attendees: [],
            attendeesTruncated: false,
            link: null,
          },
        ],
        coverage: {
          calendarList: "complete",
          calendars: [
            {
              calendarId: "cal-1",
              summary: "Work",
              accessRole: "owner",
              primary: true,
              outcome: "complete",
              retryAfterMs: null,
            },
          ],
          truncations: [],
          requests: 4,
          retryAfterMs: null,
        },
        failure: null,
      },
      "member-1",
    );

    // The calendar dates survive verbatim beside the ordering instant.
    expect(normalized.items[0]?.facts.startedAtRaw).toBe("2026-09-17");
    expect(normalized.items[0]?.facts.endsAtRaw).toBe("2026-09-19");
    expect(normalized.items[0]?.facts.containerTimezone).toBe(
      "America/Los_Angeles",
    );
    expect(normalized.provenance.startDate).toBe("2026-09-17");
    expect(normalized.provenance.endDateExclusive).toBe("2026-09-18");
    expect(normalized.provenance.timezone).toBe("Asia/Shanghai");
    // Four reads for one calendar: the envelope count is not the read count.
    expect(normalized.requests).toBe(4);
  });

  it("counts skipped Chat threads without counting policy exclusions", () => {
    const normalized = normalizeMorningBriefChat(
      {
        source: "chat",
        anchor: "2026-09-17T06:00:00.000Z",
        collectedAt: "2026-09-17T06:00:00.000Z",
        result: "collected",
        coverage: "partial",
        scope: { unreadCandidates: 4, inspectedThreads: 3 },
        items: [],
        skipped: [
          {
            threadId: "11111111-1111-4111-8111-111111111111",
            reason: "destination_thread",
          },
          {
            threadId: "22222222-2222-4222-8222-222222222222",
            reason: "morning_brief_thread",
          },
          {
            threadId: "33333333-3333-4333-8333-333333333333",
            reason: "thread_read_failed",
          },
        ],
        truncations: ["candidate_overflow"],
      },
      "member-1",
    );

    // The destination thread and Morning Brief threads were never eligible.
    expect(normalized.omittedBySource).toStrictEqual({
      known: 1,
      unknownRemaining: true,
    });
    expect(normalized.provenance.limitations).toContain("thread_read_failed");
  });
});
