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
  isMorningBriefOutputLanguage,
  planMorningBriefLanguage,
  validateReportedLanguage,
  MORNING_BRIEF_DEFAULT_LANGUAGE,
} from "../morning-brief-language-policy";
import { normalizeMorningBriefSlack } from "../morning-brief-slack-source";
import {
  boundMorningBriefDescriptors,
  morningBriefDescriptorRetainUntil,
  morningBriefScopeDigest,
  morningBriefSourcesToRevalidate,
  MORNING_BRIEF_OUTBOX_DEADLINE_MS,
  MORNING_BRIEF_RESULT_RETENTION_MS,
  type MorningBriefRetainedSourceDescriptor,
} from "../morning-brief-source-authority";
import { serializeMorningBriefItem as serializeForTest } from "../morning-brief-source-item";
import {
  morningBriefEnvelopeBytes,
  morningBriefRequestBytes,
  buildMorningBriefRequest,
  morningBriefCoverageReport,
} from "../morning-brief-request-envelope";
import {
  boundCombinedNormalizedItems,
  dedupeMorningBriefItems,
  morningBriefItemBytes,
  morningBriefItemsBytes,
  type MorningBriefSourceCollection,
  type MorningBriefSourceItem,
  type MorningBriefSourceKind,
} from "../morning-brief-source-item";

const bundleFixture = {
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

function item(
  source: MorningBriefSourceKind,
  record: string,
  overrides: Partial<MorningBriefSourceItem> = {},
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
    title: record,
    body: "",
    truncated: false,
    links: [],
    ...overrides,
  };
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
    omittedBySource: 0,
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
  it("accepts an item that exactly reaches the cap and rejects one byte more", () => {
    const only = item("slack", "m1", { body: "x".repeat(50) });
    const exact = morningBriefItemBytes(only);

    expect(
      boundCombinedNormalizedItems([collection("slack", [only])], exact)
        .omitted,
    ).toBe(0);
    expect(
      boundCombinedNormalizedItems([collection("slack", [only])], exact - 1)
        .omitted,
    ).toBe(1);
  });

  it("drops whole items and reports the source as partial", () => {
    const first = item("slack", "m1", { body: "a".repeat(40), priority: 0 });
    const second = item("slack", "m2", { body: "b".repeat(40), priority: 1 });
    const bounded = boundCombinedNormalizedItems(
      [collection("slack", [first, second])],
      morningBriefItemBytes(first),
    );

    expect(bounded.omitted).toBe(1);
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
    const allocated = allocateMorningBriefRequest(
      [collection("slack", [only])],
      { maxBytes: morningBriefItemBytes(only) },
    );

    expect(allocated.omittedItems).toBe(0);
    expect(allocated.bytes).toBe(morningBriefItemBytes(only));
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
    membershipId: "orgmem_1",
    agentId: "agent_1",
    capturedAt: "2026-09-17T06:00:00.000Z",
    containers: ["C1"],
    contributed: true,
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

  it("revalidates supplied-but-uncited material and skips sources that supplied none", () => {
    const supplied = morningBriefSourcesToRevalidate([
      descriptor,
      { ...descriptor, source: "gmail", contributed: false },
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
      instructions: { versionId: "ver_1", digest: "d1" },
      memberLocale: "en-US",
    });

    expect(plan.authority).toBe("agent-instructions");
    expect(plan.instructionsVersionId).toBe("ver_1");
    // The same call applies the fallback only when the text says nothing.
    expect(plan.fallbackLanguage).toBe("en-US");
  });

  it("uses the member locale when no instructions exist", () => {
    const plan = planMorningBriefLanguage({
      instructions: null,
      memberLocale: "ja-JP",
    });

    expect(plan.authority).toBe("member-locale");
    expect(plan.fallbackLanguage).toBe("ja-JP");
    expect(plan.instructionsDigest).toBeNull();
  });

  it("falls back to the declared default for an absent or unknown locale", () => {
    expect(
      planMorningBriefLanguage({ instructions: null, memberLocale: null })
        .authority,
    ).toBe("default");
    expect(
      planMorningBriefLanguage({ instructions: null, memberLocale: "xx-YY" })
        .fallbackLanguage,
    ).toBe(MORNING_BRIEF_DEFAULT_LANGUAGE);
  });

  it("represents Chinese independently of the UI locale enumeration", () => {
    expect(isMorningBriefOutputLanguage("zh-Hans")).toBeTruthy();
    expect(isMorningBriefOutputLanguage("zh-Hant")).toBeTruthy();
    // Settings still offers exactly the ten UI locales; neither is one of them.
    expect(
      planMorningBriefLanguage({
        instructions: null,
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
    const normalized = normalizeMorningBriefSlack(bundleFixture, {
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
    const normalized = normalizeMorningBriefSlack(bundleFixture, {
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
      { ...bundleFixture, entries: [], coverage: "empty" },
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
      instructions: null,
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
      coverage: morningBriefCoverageReport(collections, {}),
    });

    const allocated = allocateMorningBriefRequest(collections, {
      overheadBytes: envelopeBytes,
    });
    const request = buildMorningBriefRequest({
      language,
      instructions: null,
      coverage: morningBriefCoverageReport(
        collections,
        allocated.omittedBySource,
      ),
      items: allocated.items,
    });

    expect(allocated.omittedItems).toBeGreaterThan(0);
    expect(morningBriefRequestBytes(request)).toBeLessThanOrEqual(
      MORNING_BRIEF_REQUEST_MAX_BYTES,
    );
  });

  it("reserves the whole instruction file before allocating evidence", () => {
    const language = planMorningBriefLanguage({
      instructions: { versionId: "ver_1", digest: "d1" },
      memberLocale: null,
    });
    const instructions = "写成简体中文。".repeat(4096);
    const coverage = morningBriefCoverageReport([], {});

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
    const budget =
      morningBriefItemBytes(gmail[0] as MorningBriefSourceItem) +
      morningBriefItemBytes(slack[0] as MorningBriefSourceItem) -
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
    const budget =
      morningBriefItemBytes(gmail[0] as MorningBriefSourceItem) +
      morningBriefItemBytes(slack[0] as MorningBriefSourceItem);

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
    const normalized = normalizeMorningBriefSlack(bundleFixture, {
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
