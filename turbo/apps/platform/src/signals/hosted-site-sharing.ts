import { createHostedSiteDomainSignals } from "./hosted-site-domains.ts";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import type { infer as zInfer } from "zod";
import { artifactAccessContract } from "@okouai/api-contracts/client/artifact-access";
import { hostContract } from "@okouai/api-contracts/client/host";
import { hostedSiteUrlSlugSchema } from "@okouai/api-contracts/validators/host";
import type { hostedSiteUrlSchema } from "@okouai/api-contracts/contracts/host";
import type { ArtifactVisibilityValue } from "@okouai/api-contracts/contracts/artifact-access";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../i18n/index.ts";
import { accept } from "../lib/accept.ts";
import { resolveEditableHostedSiteDomain } from "../lib/platform-host.ts";
import { copyAttachmentLinkToClipboard } from "../views/okou-page/attachment-url.ts";
import { apiClient$ } from "./api-client.ts";
import { isHostedSiteUrl } from "./chat-page/parse-body-blocks.ts";
import {
  currentHostedSiteUrl,
  hostedSiteUrlChanges$,
  recordHostedSiteUrlChange$,
} from "./hosted-site-url-changes.ts";
import { createShareLinkCopy } from "./share-link-copy.ts";
import { debounceCommand, resetSignal, throttleCommand } from "./utils.ts";
import { createHostedSiteBannerSignals } from "./hosted-site-banner.ts";
import { passArtifactPaywall$ } from "./okou-page/artifact-paywall.ts";
import { createSharePeopleSignals } from "./share-people.ts";

type SiteUrl = zInfer<typeof hostedSiteUrlSchema>;
type Validation = "unchanged" | "invalid" | "available" | "taken";
type Visibility = ArtifactVisibilityValue;

/**
 * Records the choice before the throttled save runs, so a click queued behind
 * an in-flight save is what the control shows.
 */
function recordPendingChoice<T>(
  pending$: State<Visibility | null>,
  change$: Command<Promise<T>, [Visibility, AbortSignal]>,
) {
  return command(({ set }, choice: Visibility, signal: AbortSignal) => {
    set(pending$, choice);
    return set(change$, choice, signal);
  });
}

function createSiteVisibilitySignals(
  site$: Computed<Promise<SiteUrl | null>>,
  knownArtifactId?: string,
) {
  const reload$ = state(0);
  const details$ = computed(async (get) => {
    const site = await get(site$);
    if (
      !site ||
      !new URL(site.url).hostname.endsWith(
        `.${resolveEditableHostedSiteDomain()}`,
      )
    ) {
      return null;
    }
    get(reload$);
    const result = await accept(
      get(apiClient$)(artifactAccessContract).getVisibility({
        params: { artifactId: knownArtifactId ?? site.siteId },
        fetchOptions: { cache: "no-store" },
      }),
      [200, 404],
    );
    return result.status === 200
      ? {
          siteId: site.siteId,
          artifactId: result.body.artifactId,
          visibility: result.body.visibility,
        }
      : null;
  });
  const persist$ = command(
    async ({ get, set }, visibility: Visibility, signal: AbortSignal) => {
      const details = await get(details$);
      signal.throwIfAborted();
      if (!details || details.visibility === visibility) {
        return false;
      }
      await accept(
        get(apiClient$)(artifactAccessContract).updateVisibility({
          params: { artifactId: details.artifactId },
          body: { visibility },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      signal.throwIfAborted();
      set(reload$, (value) => {
        return value + 1;
      });
      await get(details$);
      signal.throwIfAborted();
      return true;
    },
  );
  // The last submitted choice, recorded by the session before throttling.
  // Views read it only while the save is in flight, so the control keeps the
  // new choice instead of clearing, and a failed save falls back to the
  // server value.
  const pending$ = state<Visibility | null>(null);
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
    },
  );
  return {
    visibility$: details$,
    pendingVisibility$: pending$,
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
    if (!details?.isActive || !(await set(passArtifactPaywall$, signal))) {
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

function createSiteUrlSignals(sourceUrl: string) {
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
      ? (details.effectiveUrl ?? details.url)
      : currentHostedSiteUrl(sourceUrl, get(hostedSiteUrlChanges$));
  });
  return { saved$, details$, copyUrl$ };
}

function createSiteSharingSettings(
  details$: Computed<Promise<SiteUrl | null>>,
  knownArtifactId?: string,
) {
  const visibility = createSiteVisibilitySignals(details$, knownArtifactId);
  const peopleTarget$ = computed(async (get) => {
    const site = await get(visibility.visibility$);
    return site ? { artifactId: site.artifactId } : null;
  });
  const people = createSharePeopleSignals(peopleTarget$);
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
  return { visibility, people, banner, hasSettings$ };
}

function createHostedSiteSaveCommand(args: {
  readonly details$: Computed<Promise<SiteUrl | null>>;
  readonly saved$: State<SiteUrl | null>;
  readonly editor: ReturnType<typeof createSiteUrlEditorSignals>;
  readonly domains: ReturnType<typeof createHostedSiteDomainSignals>;
  readonly cancel$: Command<void, []>;
  readonly linkCopy: ReturnType<typeof createShareLinkCopy>;
}) {
  const { details$, saved$, editor, domains, cancel$, linkCopy } = args;
  return throttleCommand(
    command(async ({ get, set }, signal: AbortSignal) => {
      set(linkCopy.clear$);
      const configuration = await get(domains.settings$);
      signal.throwIfAborted();
      if (!configuration) {
        return set(editor.save$, signal);
      }
      const details = await get(details$);
      signal.throwIfAborted();
      const draft = get(editor.draft$);
      if (!details || draft === null) {
        return;
      }
      const result = await set(domains.persist$, draft, signal);
      signal.throwIfAborted();
      if (!result) {
        return;
      }
      const url = result.defaultUrl;
      if (url !== details.url) {
        set(recordHostedSiteUrlChange$, details.url, url);
      }
      set(saved$, {
        ...details,
        url,
        publicSlug: new URL(url).hostname.split(".")[0]!,
        effectiveUrl: result.effectiveUrl,
      });
      set(cancel$);
      toast.success(
        i18n.t(($) => {
          return $.artifacts.siteUrl.updated;
        }),
      );
    }),
    0,
  );
}

function createHostedSiteShareSession(sourceUrl: string, artifactId?: string) {
  const signal$ = state<AbortSignal | null>(null);
  const {
    saved$,
    details$,
    copyUrl$: platformCopyUrl$,
  } = createSiteUrlSignals(sourceUrl);
  const open$ = state(false);
  const editor = createSiteUrlEditorSignals(details$, saved$);
  const domains = createHostedSiteDomainSignals(details$);
  const copyUrl$ = computed(async (get) => {
    return get(domains.effectiveUrl$) ?? (await get(platformCopyUrl$));
  });
  const edit$ = command(async ({ get, set }, signal: AbortSignal) => {
    await set(editor.edit$, signal);
    if (get(editor.editing$)) {
      await set(domains.begin$, signal);
    }
  });
  const cancel$ = command(({ set }) => {
    set(domains.back$);
    set(editor.cancel$);
  });
  const { visibility, people, banner, hasSettings$ } =
    createSiteSharingSettings(details$, artifactId);
  const resetOpenSignal$ = resetSignal();
  const linkCopy = createShareLinkCopy();
  const setOpen$ = command(({ set }, open: boolean) => {
    set(open$, open);
    if (!open) {
      set(people.clear$);
      set(resetOpenSignal$);
      set(cancel$);
      set(editor.returnFocus$, false);
      set(linkCopy.clear$);
    }
  });
  const show$ = command(async ({ get, set }, parentSignal: AbortSignal) => {
    const signal = set(resetOpenSignal$, parentSignal);
    set(people.open$, signal);
    set(open$, true);
    const hasSettings = await get(hasSettings$);
    signal.throwIfAborted();
    if (!hasSettings) {
      set(open$, false);
      const url = await get(copyUrl$);
      signal.throwIfAborted();
      await copyAttachmentLinkToClipboard(url, undefined, signal);
    }
  });
  const copy$ = command(async ({ get, set }, signal: AbortSignal) => {
    const url = await get(copyUrl$);
    signal.throwIfAborted();
    await set(linkCopy.copy$, url, signal);
  });
  const throttledVisibility$ = throttleCommand(
    command(({ set }, choice: Visibility, signal: AbortSignal) => {
      set(linkCopy.clear$);
      return set(visibility.changeVisibility$, choice, signal);
    }),
    0,
  );
  const changeVisibility$ = recordPendingChoice(
    visibility.pendingVisibility$,
    throttledVisibility$,
  );
  const save$ = createHostedSiteSaveCommand({
    details$,
    saved$,
    editor,
    domains,
    cancel$,
    linkCopy,
  });
  return {
    sourceUrl,
    signal$,
    details$,
    copyUrl$,
    hasSettings$,
    ...visibility,
    people,
    ...banner,
    changeVisibility$,
    open$,
    ...editor,
    domains,
    edit$,
    cancel$,
    save$,
    inputId: `hosted-site-url-${crypto.randomUUID()}`,
    peopleInputId: `hosted-site-people-${crypto.randomUUID()}`,
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
  const source$ = state<{
    readonly url: string;
    readonly artifactId?: string;
  } | null>(null);
  const session$ = computed((get) => {
    const source = get(source$);
    return source
      ? createHostedSiteShareSession(source.url, source.artifactId)
      : null;
  });
  const resetSession$ = resetSignal();
  const select$ = command(
    (
      { get, set },
      selection: { readonly url: string; readonly artifactId?: string },
      parentSignal: AbortSignal,
    ) => {
      parentSignal.throwIfAborted();
      const signal = set(resetSession$, parentSignal);
      if (!isHostedSiteUrl(selection.url)) {
        set(source$, null);
        return;
      }
      const source = {
        url: selection.url,
        ...(selection.artifactId ? { artifactId: selection.artifactId } : {}),
      };
      set(source$, source);
      const session = get(session$)!;
      set(session.signal$, signal);
      set(session.domains.initialize$, signal);
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
  );
  return {
    session$,
    select$,
  };
}

const scopes = Object.freeze({
  dialog: createHostedSiteShareScope(),
  sidebar: createHostedSiteShareScope(),
});
export function getHostedSiteShareScope(surface: keyof typeof scopes) {
  return scopes[surface];
}
