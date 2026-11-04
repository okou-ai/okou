import { command, computed, state } from "ccstate";
import { usageRecordContract } from "@okouai/api-contracts/client/usage-record";
import type {
  UsageRecordRange,
  UsageRecordResponse,
} from "@okouai/api-contracts/contracts/usage-record";
import { usageMembersContract } from "@okouai/api-contracts/client/usage";
import { accept } from "../../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../../api-client.ts";
import { resetSignal } from "../../utils.ts";

export type CreditBalanceTab = "mine" | "team";

const creditBalanceTabState$ = state<CreditBalanceTab>("mine");
const usagePackMembersDialogOpenState$ = state(false);
const usagePackMemberAdditionsExpandedMemberIdState$ = state<string | null>(
  null,
);
const resetUsagePackMembersDialogSignal$ = resetSignal();

export const creditBalanceTab$ = computed((get) => {
  return get(creditBalanceTabState$);
});

export const setCreditBalanceTab$ = command(
  ({ set }, tab: CreditBalanceTab) => {
    set(creditBalanceTabState$, tab);
  },
);

export const usagePackMembersDialogOpen$ = computed((get) => {
  return get(usagePackMembersDialogOpenState$);
});

export const usagePackMemberAdditionsExpandedMemberId$ = computed((get) => {
  return get(usagePackMemberAdditionsExpandedMemberIdState$);
});

const resetUsagePackMembersDialogState$ = command(({ set }) => {
  set(usagePackMembersDialogOpenState$, false);
  set(usagePackMemberAdditionsExpandedMemberIdState$, null);
});

export const openUsagePackMembersDialog$ = command(
  ({ set }, settingsDialogSignal: AbortSignal) => {
    settingsDialogSignal.throwIfAborted();
    const signal = set(
      resetUsagePackMembersDialogSignal$,
      settingsDialogSignal,
    );
    signal.addEventListener(
      "abort",
      () => {
        set(resetUsagePackMembersDialogState$);
      },
      { once: true },
    );
    set(usagePackMemberAdditionsExpandedMemberIdState$, null);
    set(usagePackMembersDialogOpenState$, true);
  },
);

export const closeUsagePackMembersDialog$ = command(({ set }) => {
  set(usagePackMembersDialogOpenState$, false);
});

export const completeUsagePackMembersDialogClose$ = command(({ get, set }) => {
  if (get(usagePackMembersDialogOpenState$)) {
    return;
  }
  set(resetUsagePackMembersDialogSignal$);
});

export const toggleUsagePackMemberAdditions$ = command(
  ({ get, set }, memberId: string) => {
    const expandedMemberId = get(
      usagePackMemberAdditionsExpandedMemberIdState$,
    );
    set(
      usagePackMemberAdditionsExpandedMemberIdState$,
      expandedMemberId === memberId ? null : memberId,
    );
  },
);

const PAGE_SIZE = 20;

interface UsageRecordQuery {
  readonly createClient: ApiClientFactory;
  readonly range: UsageRecordRange;
}

const usageRecordReload$ = state(0);
const myUsageRecordPages$ = state<readonly UsageRecordResponse[]>([]);
const myUsageRecordGeneration$ = state(0);
const myUsageRangeState$ = state<UsageRecordRange>("today");
const teamUsageRangeState$ = state<UsageRecordRange>("billingPeriod");

const resetMyUsageRecordPages$ = command(({ set }) => {
  set(myUsageRecordPages$, []);
  set(myUsageRecordGeneration$, (generation) => {
    return generation + 1;
  });
});

export const myUsageRange$ = computed((get) => {
  return get(myUsageRangeState$);
});

export const teamUsageRange$ = computed((get) => {
  return get(teamUsageRangeState$);
});

export const setMyUsageRange$ = command(({ set }, range: UsageRecordRange) => {
  set(myUsageRangeState$, range);
  set(resetMyUsageRecordPages$);
});

export const setTeamUsageRange$ = command(
  ({ set }, range: UsageRecordRange) => {
    set(teamUsageRangeState$, range);
  },
);

const myUsageRecordQuery$ = computed((get): UsageRecordQuery => {
  return {
    createClient: get(apiClient$),
    range: get(myUsageRangeState$),
  };
});

async function loadMyUsageRecordPage(
  query: UsageRecordQuery,
  page: number,
  signal?: AbortSignal,
): Promise<UsageRecordResponse> {
  const result = await accept(
    query.createClient(usageRecordContract).get({
      query: {
        page,
        pageSize: PAGE_SIZE,
        scope: "mine",
        range: query.range,
        tz: currentTimeZone(),
      },
      fetchOptions: { signal },
    }),
    [200],
    signal,
  );
  return result.body;
}

function currentTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const firstMyUsageRecordPage$ = computed(
  (get): Promise<UsageRecordResponse> => {
    get(usageRecordReload$);
    return loadMyUsageRecordPage(get(myUsageRecordQuery$), 1);
  },
);

export const myUsageRecordAsync$ = computed(async (get) => {
  const firstPage = await get(firstMyUsageRecordPage$);
  const appendedPages = get(myUsageRecordPages$);
  const latestPage = appendedPages.at(-1) ?? firstPage;
  return {
    ...latestPage,
    rows: [
      ...firstPage.rows,
      ...appendedPages.flatMap((page) => {
        return page.rows;
      }),
    ],
  };
});

export const loadMoreUsageRecord$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const generation = get(myUsageRecordGeneration$);
    const pages = get(myUsageRecordPages$);
    const loaded = await get(myUsageRecordAsync$);
    signal.throwIfAborted();
    if (
      get(myUsageRecordGeneration$) !== generation ||
      get(myUsageRecordPages$) !== pages ||
      loaded.rows.length >= loaded.pagination.total
    ) {
      return;
    }

    const nextPage = pages.length + 2;
    const next = await loadMyUsageRecordPage(
      get(myUsageRecordQuery$),
      nextPage,
      signal,
    );
    signal.throwIfAborted();
    if (
      get(myUsageRecordGeneration$) !== generation ||
      get(myUsageRecordPages$) !== pages
    ) {
      return;
    }
    set(myUsageRecordPages$, [...pages, next]);
  },
);

export const reloadUsageRecords$ = command(({ set }) => {
  set(resetMyUsageRecordPages$);
  set(usageRecordReload$, (value) => {
    return value + 1;
  });
});

export const teamMemberUsageAsync$ = computed(async (get) => {
  get(usageRecordReload$);
  const range = get(teamUsageRangeState$);
  const createClient = get(apiClient$);
  const client = createClient(usageMembersContract);
  const result = await accept(
    client.get({
      query: {
        range,
        tz: currentTimeZone(),
      },
    }),
    [200],
  );
  return result.body;
});
