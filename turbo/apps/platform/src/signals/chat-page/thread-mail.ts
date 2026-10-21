import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import {
  mailContract,
  type ThreadMailSummary,
} from "@okouai/api-contracts/contracts/mail";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { onRef, settle, withCleanup } from "../utils.ts";
import type { MailDraftCardSignalsRegistry } from "./mail-draft.ts";

export type ThreadMailFilter = "all" | "draft" | "sent";
type ThreadMailAction = "send" | "delete";
type MailSource = Computed<Promise<ThreadMailSummary[]>>;
interface MailResult {
  readonly succeeded: number;
  readonly failed: number;
}

function createMailSelectionSignals(
  mails$: MailSource,
  filtered$: MailSource,
  busy$: State<boolean>,
  result$: State<MailResult | null>,
) {
  const selected$ = state<ReadonlySet<string>>(new Set());
  const selectedDrafts$ = computed(async (get) => {
    const mails = get(mails$);
    const selected = get(selected$);
    return (await mails).filter((mail) => {
      return mail.status === "draft" && selected.has(mail.mailDraftId);
    });
  });
  const select$ = command(({ get, set }, id: string, checked: boolean) => {
    if (get(busy$)) {
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
      const mails = await get(filtered$);
      signal.throwIfAborted();
      if (get(busy$)) {
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
  return { selected$, selectedDrafts$, select$, selectAll$ };
}

function createMailBulkSignals(
  registry: MailDraftCardSignalsRegistry,
  selection: ReturnType<typeof createMailSelectionSignals>,
  refresh$: Command<void, []>,
  busy$: State<boolean>,
  result$: State<MailResult | null>,
) {
  const pending$ = state<{
    readonly action: ThreadMailAction;
    readonly mails: readonly ThreadMailSummary[];
  } | null>(null);
  const prepare$ = command(
    async ({ get, set }, action: ThreadMailAction, signal: AbortSignal) => {
      const mails = await get(selection.selectedDrafts$);
      signal.throwIfAborted();
      if (!get(busy$) && mails.length > 0) {
        set(pending$, { action, mails });
      }
    },
  );
  const cancel$ = command(({ get, set }) => {
    if (!get(busy$)) {
      set(pending$, null);
    }
  });
  const execute$ = command(async ({ get, set }, signal: AbortSignal) => {
    const pending = get(pending$);
    if (!pending || get(busy$)) {
      return;
    }
    set(busy$, true);
    set(result$, null);
    // Keep failed drafts selected; a retry never includes earlier successes.
    let succeeded = 0;
    let failed = 0;
    for (const mail of pending.mails) {
      signal.throwIfAborted();
      const href = `/mail/drafts/${mail.mailDraftId}`;
      const signals = set(registry.register$, {
        mailDraftId: mail.mailDraftId,
        href,
        originalUrl: new URL(href, window.location.origin).href,
      });
      const outcome = await settle(
        set(
          pending.action === "send" ? signals.send$ : signals.delete$,
          signal,
        ),
        signal,
      );
      signal.throwIfAborted();
      if (outcome.ok) {
        succeeded += 1;
        const next = new Set(get(selection.selected$));
        next.delete(mail.mailDraftId);
        set(selection.selected$, next);
      } else {
        failed += 1;
      }
    }
    set(result$, { succeeded, failed });
    set(pending$, null);
    set(refresh$);
  });
  const confirm$ = command(async ({ get, set }, signal: AbortSignal) => {
    if (get(busy$)) {
      return;
    }
    await withCleanup(set(execute$, signal), () => {
      set(busy$, false);
    });
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

export function createThreadMailSignals(
  threadId: string,
  registry: MailDraftCardSignalsRegistry,
  latestRunFinish$: Computed<Promise<string | undefined>>,
) {
  const open$ = state(false);
  const navigating$ = state(false);
  const query$ = state("");
  const filter$ = state<ThreadMailFilter>("all");
  const reloadVersion$ = state(0);
  const busy$ = state(false);
  const result$ = state<MailResult | null>(null);
  const mails$ = computed(async (get) => {
    get(reloadVersion$);
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
    const filter = get(filter$);
    const query = get(query$).trim().toLocaleLowerCase();
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
  const setOpen$ = command(({ set }, open: boolean) => {
    set(open$, open);
    if (open) {
      set(refresh$);
    }
  });
  const restore$ = command(({ set }) => {
    set(open$, true);
  });
  const selection = createMailSelectionSignals(
    mails$,
    filtered$,
    busy$,
    result$,
  );
  const bulk = createMailBulkSignals(
    registry,
    selection,
    refresh$,
    busy$,
    result$,
  );
  return {
    open$: computed((get) => {
      return get(open$);
    }),
    setOpen$,
    restore$,
    navigating$,
    refresh$,
    query$,
    filter$,
    mails$,
    filtered$,
    ...selection,
    selected$: computed((get) => {
      return get(selection.selected$);
    }),
    ...bulk,
    busy$: computed((get) => {
      return get(busy$);
    }),
    result$: computed((get) => {
      return get(result$);
    }),
    listRef$: createMailListRef(),
    register$: registry.register$,
  };
}

export type ThreadMailSignals = ReturnType<typeof createThreadMailSignals>;
