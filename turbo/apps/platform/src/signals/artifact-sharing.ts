import { command, computed, state, type Computed, type State } from "ccstate";
import {
  artifactReferencesContract,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import {
  artifactSharesContract,
  type ArtifactShareStatus,
  type ArtifactShareTarget,
} from "@okouai/api-contracts/contracts/artifact-shares";
import { privateHostedDeploymentId } from "@okouai/core/private-hosted-artifact";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../i18n/index.ts";
import { accept } from "../lib/accept.ts";
import { copyAttachmentLinkToClipboard } from "../views/okou-page/attachment-url.ts";
import { apiClient$, type ApiClientFactory } from "./api-client.ts";
import { resolveApiBase } from "./api-base.ts";
import { isAuthenticatedAttachmentUrl } from "./attachment-resource-url.ts";
import { throttleCommand } from "./command-scheduling.ts";
import { pageSignal$ } from "./page-signal.ts";
import {
  onRef,
  resetSignal,
  settle,
  waitForOperation,
  withCleanup,
} from "./utils.ts";

function artifactSharingTarget(url: string): ArtifactShareTarget | null {
  const id = privateHostedDeploymentId(url, resolveApiBase());
  if (id) {
    return { kind: "html", id };
  }
  if (!isAuthenticatedAttachmentUrl(url)) {
    return null;
  }
  const fileId = new URL(url).searchParams.get("file_id");
  return fileId ? { kind: "file", id: fileId } : null;
}

export function isShareableArtifactReference(url: string): boolean {
  return (
    parseArtifactReference(url, location.origin) !== null ||
    artifactSharingTarget(url) !== null
  );
}

interface ShareSource {
  readonly url: string;
  readonly copyUrl?: string;
}
type Audience = ArtifactShareStatus["audience"];
interface AudienceDraft {
  readonly audience: Audience;
}

async function loadShareDetails(client: ApiClientFactory, source: ShareSource) {
  const reference = parseArtifactReference(source.url, location.origin);
  const resolved = reference
    ? (
        await accept(
          client(artifactReferencesContract).resolve({
            params: { reference: `${reference.hash}${reference.extension}` },
            fetchOptions: { cache: "no-store" },
          }),
          [200],
        )
      ).body
    : null;
  const target = resolved?.target ?? artifactSharingTarget(source.url);
  if (!target) {
    return null;
  }
  // A conversation snapshot is independent of its source resource, including
  // when its owner opens it in a normal thread's preview surface.
  if (resolved?.sharedThreadSnapshot) {
    return {
      target,
      status: null,
      audience: undefined,
      copyUrl: new URL(source.copyUrl ?? source.url, location.origin).href,
    };
  }
  // Viewing access does not imply ownership. Only this endpoint authorizes the
  // permission controls; its 404 response identifies a read-only recipient.
  const result = await accept(
    client(artifactSharesContract).status({
      body: target,
    }),
    [200, 404],
  );
  const status = result.status === 200 ? result.body : null;
  const copyUrl = new URL(
    status ? status.ownerUrl : (source.copyUrl ?? source.url),
    location.origin,
  );
  if (status) {
    copyUrl.hash = reference?.fragment ?? "";
  }
  const audience =
    status?.selectedTarget && status.selectedTarget.id !== target.id
      ? "private"
      : status?.audience;
  return { target, status, audience, copyUrl: copyUrl.href };
}
type ShareDetails = Awaited<ReturnType<typeof loadShareDetails>>;

function createAudienceSignals(
  details$: Computed<Promise<ShareDetails>>,
  reload$: State<number>,
) {
  // The user's latest choice stays visible while earlier writes settle. Object
  // identity prevents an earlier completion from clearing a newer selection.
  const draft$ = state<AudienceDraft | null>(null);
  const persist$ = command(
    async ({ get, set }, draft: AudienceDraft, signal: AbortSignal) => {
      const details = await waitForOperation(get(details$), signal);
      signal.throwIfAborted();
      if (!details?.status) {
        return;
      }
      if (
        details.audience === draft.audience &&
        (draft.audience === "private" ||
          details.status.selectedTarget?.id === details.target.id)
      ) {
        return;
      }
      await withCleanup(
        accept(
          get(apiClient$)(artifactSharesContract).update({
            body: { target: details.target, audience: draft.audience },
            fetchOptions: { signal },
          }),
          [200],
          signal,
        ),
        () => {
          if (!signal.aborted) {
            set(reload$, (value) => {
              return value + 1;
            });
          }
        },
      );
      signal.throwIfAborted();
      await waitForOperation(get(details$), signal);
      signal.throwIfAborted();
      if (get(draft$) === draft) {
        toast.success(
          i18n.t(($) => {
            return $.artifacts.sharing.permissionsUpdated;
          }),
        );
      }
    },
  );
  const save$ = throttleCommand(
    command(({ get, set }, draft: AudienceDraft, signal: AbortSignal) => {
      return withCleanup(set(persist$, draft, signal), () => {
        if (get(draft$) === draft) {
          set(draft$, null);
        }
      });
    }),
    0,
  );
  const change$ = command(
    ({ get, set }, audience: Audience, signal: AbortSignal) => {
      signal.throwIfAborted();
      const current = get(draft$);
      const draft = current?.audience === audience ? current : { audience };
      set(draft$, draft);
      return set(save$, draft, signal);
    },
  );
  return { draft$, change$ };
}

function createArtifactShareSession(source: ShareSource) {
  // The mount owner installs its live signal after this graph is constructed.
  const signal$ = state<AbortSignal | null>(null);
  const reload$ = state(0);
  const details$ = computed((get) => {
    get(reload$);
    return loadShareDetails(get(apiClient$), source);
  });
  const open$ = state(false);
  const resetOpenSignal$ = resetSignal();
  const close$ = command(({ set }) => {
    set(open$, false);
    set(resetOpenSignal$);
  });
  const show$ = command(async ({ get, set }, parentSignal: AbortSignal) => {
    const signal = set(resetOpenSignal$, parentSignal);
    set(open$, true);
    // Errors belong to the popover's retry state, not a toast from opening it.
    const result = await settle(
      waitForOperation(get(details$), signal),
      signal,
    );
    if (result.ok && !result.value?.status) {
      set(open$, false);
      if (result.value) {
        await copyAttachmentLinkToClipboard(
          result.value.copyUrl,
          undefined,
          signal,
        );
      }
    }
  });
  const refresh$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(reload$, (value) => {
      return value + 1;
    });
    await settle(waitForOperation(get(details$), signal), signal);
  });
  const copy$ = command(async ({ get }, signal: AbortSignal) => {
    const details = await waitForOperation(get(details$), signal);
    signal.throwIfAborted();
    if (details?.status) {
      await copyAttachmentLinkToClipboard(details.copyUrl, undefined, signal);
    }
  });
  return {
    signal$,
    details$,
    open$,
    close$,
    show$,
    refresh$,
    copy$,
    ...createAudienceSignals(details$, reload$),
  };
}
export type ArtifactShareSession = ReturnType<
  typeof createArtifactShareSession
>;

function createArtifactShareScope() {
  const source$ = state<ShareSource | null>(null);
  const session$ = computed((get) => {
    const source = get(source$);
    return source ? createArtifactShareSession(source) : null;
  });
  const resetMountSignal$ = resetSignal();
  const mountRef$ = onRef(
    command(
      ({ get, set }, element: HTMLSpanElement, mountSignal: AbortSignal) => {
        const url = element.dataset.shareUrl;
        if (!url) {
          return;
        }
        const signal = set(resetMountSignal$, mountSignal, get(pageSignal$));
        signal.throwIfAborted();
        const source = { url, copyUrl: element.dataset.copyUrl };
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

// These are the three existing singleton preview surfaces, not a URL cache.
const shareScopes = Object.freeze({
  dialog: createArtifactShareScope(),
  sidebar: createArtifactShareScope(),
  viewer: createArtifactShareScope(),
});
export function getArtifactShareScope(surface: keyof typeof shareScopes) {
  return shareScopes[surface];
}
