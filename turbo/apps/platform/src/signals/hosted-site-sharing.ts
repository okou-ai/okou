import { command, computed, state, type Computed, type State } from "ccstate";
import type { infer as zInfer } from "zod";
import {
  hostContract,
  hostedSiteUrlSlugSchema,
  type hostedSiteUrlSchema,
} from "@okouai/api-contracts/contracts/host";
import type { hostedSiteVisibilitySchema } from "@okouai/api-contracts/contracts/hosted-site-access";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../i18n/index.ts";
import { accept } from "../lib/accept.ts";
import { resolveEditableHostedSiteDomain } from "../lib/platform-host.ts";
import { copyAttachmentLinkToClipboard } from "../views/okou-page/attachment-url.ts";
import { apiClient$ } from "./api-client.ts";
import { debounceCommand, throttleCommand } from "./command-scheduling.ts";
import { pageSignal$ } from "./page-signal.ts";
import {
  currentHostedSiteUrl,
  hostedSiteUrlChanges$,
  recordHostedSiteUrlChange$,
} from "./hosted-site-url-changes.ts";
import { createShareLinkCopy } from "./share-link-copy.ts";
import { recordHostedSiteVisibilityChange$ } from "./hosted-site-visibility-changes.ts";
import { onRef, resetSignal } from "./utils.ts";
import { createHostedSiteBannerSignals } from "./hosted-site-banner.ts";

type SiteUrl = zInfer<typeof hostedSiteUrlSchema>;
type Validation = "unchanged" | "invalid" | "available" | "taken";
type Visibility = zInfer<typeof hostedSiteVisibilitySchema>;

function createSiteVisibilitySignals(sourceUrl: string) {
  const currentSource$ = computed((get) => {
    return currentHostedSiteUrl(sourceUrl, get(hostedSiteUrlChanges$));
  });
  const reload$ = state(0);
  const details$ = computed(async (get) => {
    const url = new URL(get(currentSource$));
    if (!url.hostname.endsWith(`.${resolveEditableHostedSiteDomain()}`)) {
      return null;
    }
    get(reload$);
    // Resolve the publication, then let the visibility endpoint authorize ownership.
    const alias = await accept(
      get(apiClient$)(hostContract).resolveAlias({
        params: { publicSlug: url.hostname.split(".")[0]! },
        query: { publicBrand: "okou" },
        fetchOptions: { cache: "no-store" },
      }),
      [200],
    );
    if (!alias.body.pointer) {
      return null;
    }
    const result = await accept(
      get(apiClient$)(hostContract).siteVisibility({
        params: { siteId: alias.body.pointer.siteId },
        fetchOptions: { cache: "no-store" },
      }),
      [200, 404],
    );
    return result.status === 200 ? result.body : null;
  });
  const persist$ = command(
    async ({ get, set }, visibility: Visibility, signal: AbortSignal) => {
      const details = await get(details$);
      signal.throwIfAborted();
      if (!details || details.visibility === visibility) {
        return false;
      }
      const updated = await accept(
        get(apiClient$)(hostContract).updateSiteVisibility({
          params: { siteId: details.siteId },
          body: { visibility, expectedRevision: details.revision },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      signal.throwIfAborted();
      set(reload$, (value) => {
        return value + 1;
      });
      set(recordHostedSiteVisibilityChange$, {
        url: sourceUrl,
        revision: updated.body.revision,
      });
      await get(details$);
      signal.throwIfAborted();
      return true;
    },
  );
  const change$ = command(
    async ({ set }, visibility: Visibility, signal: AbortSignal) => {
      const updated = await set(persist$, visibility, signal);
      signal.throwIfAborted();
      if (updated) {
        toast.success(
          i18n.t(($) => {
            return $.artifacts.sharing.permissionsUpdated;
          }),
        );
      }
      return updated;
    },
  );
  return {
    visibility$: details$,
    changeVisibility$: change$,
  };
}

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
  const editing$ = computed((get) => {
    return get(draft$) !== null;
  });
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
    const details = await get(details$);
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
      const details = await get(details$);
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
    const details = await get(details$);
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
    return true;
  });
  return {
    draft$,
    editing$,
    validation$,
    saveConflict$,
    returnFocus$,
    edit$,
    change$,
    cancel$,
    save$: persist$,
  };
}

function createHostedSiteShareSession(sourceUrl: string) {
  const signal$ = state<AbortSignal | null>(null);
  const saved$ = state<SiteUrl | null>(null);
  const currentUrl$ = computed((get) => {
    return currentHostedSiteUrl(
      get(saved$)?.url ?? sourceUrl,
      get(hostedSiteUrlChanges$),
    );
  });
  const details$ = computed(async (get) => {
    const saved = get(saved$);
    const currentUrl = get(currentUrl$);
    if (saved) {
      return {
        ...saved,
        url: currentUrl,
        publicSlug: new URL(currentUrl).hostname.split(".")[0]!,
      };
    }
    const url = new URL(currentUrl);
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
  const visibility = createSiteVisibilitySignals(sourceUrl);
  const banner = createHostedSiteBannerSignals(visibility.visibility$);
  const hasSettings$ = computed(async (get) => {
    const [details, permissions] = await Promise.all([
      get(details$),
      get(visibility.visibility$),
    ]);
    return (
      permissions !== null ||
      (details?.isActive === true &&
        new URL(details.url).hostname.endsWith(
          `.${resolveEditableHostedSiteDomain()}`,
        ))
    );
  });
  const resetOpenSignal$ = resetSignal();
  const linkCopy = createShareLinkCopy();
  const setOpen$ = command(({ set }, open: boolean) => {
    set(open$, open);
    if (!open) {
      set(resetOpenSignal$);
      set(editor.cancel$);
      set(editor.returnFocus$, false);
      set(linkCopy.clear$);
    }
  });
  const show$ = command(
    async (
      { get, set },
      copyIfReadOnly: boolean,
      parentSignal: AbortSignal,
    ) => {
      const signal = set(resetOpenSignal$, parentSignal);
      set(open$, true);
      const hasSettings = await get(hasSettings$);
      signal.throwIfAborted();
      if (!hasSettings) {
        set(open$, false);
        if (copyIfReadOnly) {
          const url = await get(copyUrl$);
          signal.throwIfAborted();
          await copyAttachmentLinkToClipboard(url, undefined, signal);
        }
      }
    },
  );
  const copy$ = command(async ({ get, set }, signal: AbortSignal) => {
    const url = await get(copyUrl$);
    signal.throwIfAborted();
    await set(linkCopy.copy$, url, signal);
  });
  const changeVisibility$ = throttleCommand(
    command(async ({ set }, choice: Visibility, signal: AbortSignal) => {
      set(linkCopy.clear$);
      const updated = await set(visibility.changeVisibility$, choice, signal);
      if (updated) {
        await set(copy$, signal);
      }
    }),
    0,
  );
  const save$ = throttleCommand(
    command(async ({ set }, signal: AbortSignal) => {
      set(linkCopy.clear$);
      const updated = await set(editor.save$, signal);
      if (updated) {
        await set(copy$, signal);
      }
    }),
    0,
  );
  return {
    signal$,
    details$,
    copyUrl$,
    hasSettings$,
    ...visibility,
    ...banner,
    changeVisibility$,
    open$,
    ...editor,
    save$,
    inputId: `hosted-site-url-${crypto.randomUUID()}`,
    setOpen$,
    show$,
    copy$,
    copiedUrl$: linkCopy.copiedUrl$,
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
