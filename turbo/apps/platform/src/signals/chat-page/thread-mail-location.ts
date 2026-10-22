import { command, computed } from "ccstate";

import { activeRoute$ } from "../active-route.ts";
import { hash$, searchParams$, updateSearchParams$ } from "../route.ts";
import { parseMailDraftUrl } from "./mail-draft.ts";

export type ThreadMailDestination =
  | { readonly view: "list" }
  | {
      readonly view: "detail";
      readonly mailDraftId: string;
      readonly fromList?: true;
    };

export const THREAD_MAIL_SEARCH_PARAMS = [
  "mailThread",
  "mailView",
  "mailId",
  "mailFrom",
  "mailFilter",
  "mailQuery",
] as const;

export function withoutThreadMailParams(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  for (const key of THREAD_MAIL_SEARCH_PARAMS) {
    next.delete(key);
  }
  return next;
}

export function threadMailParams(
  params: URLSearchParams,
  threadId: string,
  destination: ThreadMailDestination,
): URLSearchParams {
  const next =
    params.get("mailThread") === threadId
      ? new URLSearchParams(params)
      : withoutThreadMailParams(params);
  next.set("mailThread", threadId);
  next.set("mailView", destination.view);
  if (destination.view === "detail") {
    next.set("mailId", destination.mailDraftId);
  } else {
    next.delete("mailId");
  }
  if (destination.view === "detail" && destination.fromList) {
    next.set("mailFrom", "list");
  } else {
    next.delete("mailFrom");
  }
  return next;
}

export const threadMailLocation$ = computed(
  (get): (ThreadMailDestination & { readonly threadId: string }) | null => {
    if (get(activeRoute$) !== "chat") {
      return null;
    }
    const params = get(searchParams$);
    const threadId = params.get("mailThread");
    if (!threadId) {
      return null;
    }
    if (params.get("mailView") === "list") {
      return { threadId, view: "list" };
    }
    if (params.get("mailView") !== "detail") {
      return null;
    }
    const descriptor = parseMailDraftUrl(
      `/mail/drafts/${params.get("mailId") ?? ""}`,
    );
    return descriptor
      ? {
          threadId,
          view: "detail",
          mailDraftId: descriptor.mailDraftId,
          ...(params.get("mailFrom") === "list" ? { fromList: true } : {}),
        }
      : null;
  },
);

export const closeThreadMailLocation$ = command(
  ({ get, set }, threadId?: string) => {
    const location = get(threadMailLocation$);
    if (!location || (threadId && location.threadId !== threadId)) {
      return;
    }
    set(
      updateSearchParams$,
      withoutThreadMailParams(get(searchParams$)),
      {},
      get(hash$),
    );
  },
);
