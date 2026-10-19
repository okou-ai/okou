import { command, computed, state, type Computed, type State } from "ccstate";
import type { z } from "zod";
import {
  hostContract,
  hostedSiteUrlSlugSchema,
  type hostedSiteUrlSchema,
} from "@okouai/api-contracts/contracts/host";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../i18n/index.ts";
import { accept } from "../lib/accept.ts";
import { copyAttachmentLinkToClipboard } from "../views/okou-page/attachment-url.ts";
import { apiClient$ } from "./api-client.ts";
import { debounceCommand, throttleCommand } from "./command-scheduling.ts";
import { pageSignal$ } from "./page-signal.ts";
import {
  currentHostedSiteUrl,
  hostedSiteUrlChanges$,
  recordHostedSiteUrlChange$,
} from "./hosted-site-url-changes.ts";
import { onRef, resetSignal, waitForOperation } from "./utils.ts";

type SiteUrl = z.infer<typeof hostedSiteUrlSchema>;
type Validation = "unchanged" | "invalid" | "available" | "taken";

function createSiteUrlCheck(validation$: State<Validation>) {
  return debounceCommand(
    command(
      async (
        { get, set },
        siteId: string,
        publicSlug: string,
        checkSignal: AbortSignal,
      ) => {
        const result = await accept(
          get(apiClient$)(hostContract).siteUrlAvailability({
            params: { siteId },
            query: { publicSlug },
            fetchOptions: { signal: checkSignal },
          }),
          [200],
          checkSignal,
        );
        checkSignal.throwIfAborted();
        set(validation$, result.body.available ? "available" : "taken");
      },
    ),
    300,
  );
}

function createSiteUrlEditorSignals(
  details$: Computed<Promise<SiteUrl | null>>,
  saved$: State<SiteUrl | null>,
) {
  const draft$ = state<string | null>(null);
  const validation$ = state<Validation>("unchanged");
  const saveConflict$ = state(false);
  const returnFocus$ = state(false);
  const resetCheck$ = resetSignal();
  const cancel$ = command(({ get, set }) => {
    set(returnFocus$, get(draft$) !== null);
    set(resetCheck$);
    set(draft$, null);
    set(saveConflict$, false);
  });
  const edit$ = command(async ({ get, set }, signal: AbortSignal) => {
    const details = await waitForOperation(get(details$), signal);
    signal.throwIfAborted();
    if (!details?.isActive) {
      return;
    }
    set(draft$, details.publicSlug);
    set(validation$, "unchanged");
    set(saveConflict$, false);
  });
  const check$ = createSiteUrlCheck(validation$);
  const change$ = command(
    async ({ get, set }, value: string, signal: AbortSignal) => {
      const checkSignal = set(resetCheck$, signal);
      set(draft$, value);
      set(saveConflict$, false);
      if (!hostedSiteUrlSlugSchema.safeParse(value).success) {
        set(validation$, "invalid");
        return;
      }
      set(validation$, "unchanged");
      const details = await waitForOperation(get(details$), checkSignal);
      signal.throwIfAborted();
      checkSignal.throwIfAborted();
      if (!details) {
        return;
      }
      if (details.publicSlug === value) {
        set(validation$, "unchanged");
        return;
      }
      await set(check$, details.siteId, value, checkSignal);
    },
  );
  const persist$ = command(async ({ get, set }, signal: AbortSignal) => {
    const details = await waitForOperation(get(details$), signal);
    signal.throwIfAborted();
    const draft = get(draft$);
    if (
      !details?.isActive ||
      draft === null ||
      get(validation$) !== "available"
    ) {
      return;
    }
    const result = await accept(
      get(apiClient$)(hostContract).updateSiteUrl({
        params: { siteId: details.siteId },
        body: { publicSlug: draft, expectedPublicSlug: details.publicSlug },
        fetchOptions: { signal },
      }),
      [200, 409],
      signal,
    );
    signal.throwIfAborted();
    if (result.status === 409) {
      set(saveConflict$, true);
      return;
    }
    set(saved$, result.body);
    set(recordHostedSiteUrlChange$, details.url, result.body.url);
    set(cancel$);
    toast.success(
      i18n.t(($) => {
        return $.artifacts.siteUrl.updated;
      }),
    );
  });
  const save$ = throttleCommand(persist$, 0);
  return {
    draft$,
    validation$,
    saveConflict$,
    returnFocus$,
    edit$,
    change$,
    cancel$,
    save$,
  };
}

function createHostedSiteShareSession(sourceUrl: string) {
  const signal$ = state<AbortSignal | null>(null);
  const saved$ = state<SiteUrl | null>(null);
  const reload$ = state(0);
  const details$ = computed(async (get) => {
    const changes = get(hostedSiteUrlChanges$);
    const saved = get(saved$);
    if (saved) {
      const url = currentHostedSiteUrl(saved.url, changes);
      return {
        ...saved,
        url,
        publicSlug: new URL(url).hostname.split(".")[0]!,
      };
    }
    get(reload$);
    const url = new URL(
      currentHostedSiteUrl(sourceUrl, get(hostedSiteUrlChanges$)),
    );
    const result = await accept(
      get(apiClient$)(hostContract).siteUrl({
        params: { publicSlug: url.hostname.split(".")[0]! },
        query: { hostname: url.hostname },
        fetchOptions: { cache: "no-store" },
      }),
      [200, 403, 404],
    );
    return result.status === 200 ? result.body : null;
  });
  const copyUrl$ = computed(async (get) => {
    const details = await get(details$);
    return details?.isActive
      ? details.url
      : currentHostedSiteUrl(sourceUrl, get(hostedSiteUrlChanges$));
  });
  const open$ = state(false);
  const editor = createSiteUrlEditorSignals(details$, saved$);
  const setOpen$ = command(({ set }, open: boolean) => {
    set(open$, open);
    if (!open) {
      set(editor.cancel$);
      set(editor.returnFocus$, false);
    }
  });
  const refresh$ = command(({ set }) => {
    set(reload$, (value) => {
      return value + 1;
    });
  });
  const copy$ = command(async ({ get }, signal: AbortSignal) => {
    const url = await waitForOperation(get(copyUrl$), signal);
    signal.throwIfAborted();
    await copyAttachmentLinkToClipboard(url, undefined, signal);
  });
  return {
    signal$,
    details$,
    copyUrl$,
    open$,
    ...editor,
    inputId: `hosted-site-url-${crypto.randomUUID()}`,
    setOpen$,
    refresh$,
    copy$,
  };
}

export type HostedSiteShareSession = ReturnType<
  typeof createHostedSiteShareSession
>;

function createHostedSiteShareScope() {
  const source$ = state<{ readonly url: string } | null>(null);
  const session$ = computed((get) => {
    const source = get(source$);
    return source ? createHostedSiteShareSession(source.url) : null;
  });
  const resetMount$ = resetSignal();
  const mountRef$ = onRef(
    command(
      ({ get, set }, element: HTMLSpanElement, mountSignal: AbortSignal) => {
        const url = element.dataset.shareUrl;
        if (!url) {
          return;
        }
        const signal = set(resetMount$, mountSignal, get(pageSignal$));
        signal.throwIfAborted();
        const source = { url };
        set(source$, source);
        const session = get(session$)!;
        set(session.signal$, signal);
        signal.addEventListener(
          "abort",
          () => {
            if (get(source$) === source) {
              set(source$, null);
            }
          },
          { once: true },
        );
      },
    ),
  );
  return { session$, mountRef$ };
}

const scopes = Object.freeze({
  dialog: createHostedSiteShareScope(),
  sidebar: createHostedSiteShareScope(),
});
export function getHostedSiteShareScope(surface: keyof typeof scopes) {
  return scopes[surface];
}
