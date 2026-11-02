import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { mailContract } from "@okouai/api-contracts/client/mail";
import type { ThreadMailSummary } from "@okouai/api-contracts/contracts/mail";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { onRef, settle } from "../utils.ts";
import { hash$, replaceSearchParams$, searchParams$ } from "../route.ts";
import type { MailDraftCardSignalsRegistry } from "./mail-draft.ts";
import {
  closeThreadMailLocation$,
  threadMailLocation$,
  threadMailParams,
} from "./thread-mail-location.ts";

export type ThreadMailFilter = "all" | "draft" | "sent";
type ThreadMailAction = "send" | "delete";
type MailSource = Computed<Promise<ThreadMailSummary[]>>;
interface MailResult {
  readonly succeeded: number;
  readonly failed: number;
  readonly awaitingConfirmation: number;
}
interface MailConfirmation {
  readonly action: ThreadMailAction;
  readonly mails: readonly ThreadMailSummary[];
}

function createMailSelectionSignals(
  mails$: MailSource,
  filtered$: MailSource,
  pending$: State<MailConfirmation | null>,
  result$: State<MailResult | null>,
) {
  const selected$ = state<ReadonlySet<string>>(new Set());
  const filteredDrafts$ = computed(async (get) => {
    return (await get(filtered$)).filter((mail) => {
      return mail.status === "draft";
    });
  });
  const selectedDrafts$ = computed(async (get) => {
    const mails = get(mails$);
    const selected = get(selected$);
    return (await mails).filter((mail) => {
      return mail.status === "draft" && selected.has(mail.mailDraftId);
    });
  });
  const select$ = command(({ get, set }, id: string, checked: boolean) => {
    if (get(pending$) !== null) {
      return;
    }
    const next = new Set(get(selected$));
    if (checked) {
      next.add(id);
    } else {
      next.delete(id);
    }
    set(selected$, next);
    set(result$, null);
  });
  const selectAll$ = command(
    async ({ get, set }, checked: boolean, signal: AbortSignal) => {
      const mails = await get(filteredDrafts$);
      signal.throwIfAborted();
      if (get(pending$) !== null) {
        return;
      }
      const next = new Set(get(selected$));
      for (const mail of mails) {
        if (checked) {
          next.add(mail.mailDraftId);
        } else {
          next.delete(mail.mailDraftId);
        }
      }
      set(selected$, next);
      set(result$, null);
    },
  );
  return { filteredDrafts$, selected$, selectedDrafts$, select$, selectAll$ };
}

function createMailBulkSignals(
  registry: MailDraftCardSignalsRegistry,
  selection: ReturnType<typeof createMailSelectionSignals>,
  refresh$: Command<void, []>,
  pending$: State<MailConfirmation | null>,
  result$: State<MailResult | null>,
) {
  const prepare$ = command(
    async ({ get, set }, action: ThreadMailAction, signal: AbortSignal) => {
      const mails = await get(selection.selectedDrafts$);
      signal.throwIfAborted();
      if (get(pending$) === null && mails.length > 0) {
        set(pending$, { action, mails });
      }
    },
  );
  const cancel$ = command(({ set }) => {
    set(pending$, null);
  });
  const confirm$ = command(async ({ get, set }, signal: AbortSignal) => {
    const pending = get(pending$);
    if (!pending) {
      return;
    }
    set(result$, null);
    // Remove successful drafts from the selection and retain unsuccessful drafts.
    let succeeded = 0;
    let failed = 0;
    let awaitingConfirmation = 0;
    for (const mail of pending.mails) {
      signal.throwIfAborted();
      const href = `/mail/drafts/${mail.mailDraftId}`;
      const signals = set(registry.register$, {
        mailDraftId: mail.mailDraftId,
        href,
        originalUrl: new URL(href, window.location.origin).href,
      });
      // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
      const outcome = await settle<unknown>(
        pending.action === "send"
          ? set(signals.send$, signal)
          : set(signals.delete$, signal),
        signal,
      );
      signal.throwIfAborted();
      if (
        outcome.ok &&
        (pending.action === "delete" ||
          outcome.value === "sent" ||
          outcome.value === "sending")
      ) {
        if (outcome.value === "sending") {
          awaitingConfirmation += 1;
        } else {
          succeeded += 1;
        }
        const next = new Set(get(selection.selected$));
        next.delete(mail.mailDraftId);
        set(selection.selected$, next);
      } else {
        failed += 1;
      }
    }
    set(result$, { succeeded, failed, awaitingConfirmation });
    set(pending$, null);
    set(refresh$);
  });
  return {
    prepare$,
    cancel$,
    confirm$,
    pending$: computed((get) => {
      return get(pending$);
    }),
  };
}

function createMailListRef() {
  let scrollTop = 0;
  return onRef(
    command((_context, element: HTMLDivElement, signal: AbortSignal) => {
      element.scrollTop = scrollTop;
      element.addEventListener(
        "scroll",
        () => {
          scrollTop = element.scrollTop;
        },
        { signal },
      );
    }),
  );
}

function createMailLocationSignals(threadId: string) {
  const open$ = computed((get) => {
    const location = get(threadMailLocation$);
    return location?.threadId === threadId && location.view === "list";
  });
  const query$ = computed((get) => {
    const params = get(searchParams$);
    return params.get("mailThread") === threadId
      ? (params.get("mailQuery") ?? "")
      : "";
  });
  const filter$ = computed((get): ThreadMailFilter => {
    const params = get(searchParams$);
    const filter =
      params.get("mailThread") === threadId ? params.get("mailFilter") : null;
    return filter === "draft" || filter === "sent" ? filter : "all";
  });
  const setQuery$ = command(({ get, set }, query: string) => {
    const params = threadMailParams(get(searchParams$), threadId, {
      view: "list",
    });
    if (query) {
      params.set("mailQuery", query);
    } else {
      params.delete("mailQuery");
    }
    set(replaceSearchParams$, params, {}, get(hash$));
  });
  const setFilter$ = command(({ get, set }, filter: ThreadMailFilter) => {
    const params = threadMailParams(get(searchParams$), threadId, {
      view: "list",
    });
    if (filter === "all") {
      params.delete("mailFilter");
    } else {
      params.set("mailFilter", filter);
    }
    set(replaceSearchParams$, params, {}, get(hash$));
  });
  const close$ = command(({ get, set }) => {
    // A delayed popup dismissal must not close the detail that replaced it.
    if (get(open$)) {
      set(closeThreadMailLocation$, threadId);
    }
  });
  return { open$, close$, query$, setQuery$, filter$, setFilter$ };
}

export function createThreadMailSignals(
  threadId: string,
  registry: MailDraftCardSignalsRegistry,
  latestRunFinish$: Computed<Promise<string | undefined>>,
) {
  const location = createMailLocationSignals(threadId);
  const reloadVersion$ = state(0);
  const pending$ = state<MailConfirmation | null>(null);
  const result$ = state<MailResult | null>(null);
  const mails$ = computed(async (get) => {
    get(reloadVersion$);
    get(location.open$);
    // Refresh for new links and completed runs, including links outside the
    // currently rendered transcript window.
    get(registry.values$);
    const latestRunFinish = get(latestRunFinish$);
    const client = get(apiClient$)(mailContract);
    await latestRunFinish;
    const response = await accept(
      client.listThreadMail({ params: { threadId } }),
      [200],
    );
    return response.body.mails;
  });
  const filtered$ = computed(async (get) => {
    const mails = get(mails$);
    const filter = get(location.filter$);
    const query = get(location.query$).trim().toLocaleLowerCase();
    return (await mails).filter((mail) => {
      return (
        (filter === "all" || mail.status === filter) &&
        (!query ||
          `${mail.subject} ${mail.from}`.toLocaleLowerCase().includes(query))
      );
    });
  });
  const refresh$ = command(({ set }) => {
    set(reloadVersion$, (version) => {
      return version + 1;
    });
  });
  const prepareLocation$ = command(({ get, set }) => {
    const location = get(threadMailLocation$);
    if (location?.threadId !== threadId || location.view !== "detail") {
      return;
    }
    const href = `/mail/drafts/${location.mailDraftId}`;
    set(registry.register$, {
      mailDraftId: location.mailDraftId,
      href,
      originalUrl: new URL(href, window.location.origin).href,
    });
  });
  const selection = createMailSelectionSignals(
    mails$,
    filtered$,
    pending$,
    result$,
  );
  const bulk = createMailBulkSignals(
    registry,
    selection,
    refresh$,
    pending$,
    result$,
  );
  return {
    ...location,
    prepareLocation$,
    refresh$,
    mails$,
    filtered$,
    ...selection,
    selected$: computed((get) => {
      return get(selection.selected$);
    }),
    ...bulk,
    result$: computed((get) => {
      return get(result$);
    }),
    listRef$: createMailListRef(),
    backLinkRef$: onRef(
      command((_context, element: HTMLAnchorElement, _signal: AbortSignal) => {
        element.focus({ preventScroll: true });
      }),
    ),
    register$: registry.register$,
  };
}

export type ThreadMailSignals = ReturnType<typeof createThreadMailSignals>;
