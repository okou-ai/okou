import { command, computed, state, type Computed, type State } from "ccstate";
import {
  artifactReferencesContract,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import {
  artifactSharesContract,
  artifactShareTargetSchema,
  type ArtifactShareStatus,
  type ArtifactShareTarget,
} from "@okouai/api-contracts/contracts/artifact-shares";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../i18n/index.ts";
import { accept } from "../lib/accept.ts";
import { copyAttachmentLinkToClipboard } from "../views/okou-page/attachment-url.ts";
import { apiClient$, type ApiClientFactory } from "./api-client.ts";
import {
  isAuthenticatedAttachmentUrl,
  type ArtifactShareIdentity,
} from "./attachment-resource-url.ts";
import { throttleCommand } from "./command-scheduling.ts";
import { pageSignal$ } from "./page-signal.ts";
import { createShareLinkCopy } from "./share-link-copy.ts";
import { onRef, resetSignal } from "./utils.ts";

// Hosted sites are public publications addressed by their own URL, so the
// viewer offers their link instead of an artifact permission control.
function artifactSharingTarget(url: string): ArtifactShareTarget | null {
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
  readonly artifactShareIdentity?: ArtifactShareIdentity;
}
type Audience = ArtifactShareStatus["audience"];

async function loadShareDetails(client: ApiClientFactory, source: ShareSource) {
  const reference = parseArtifactReference(source.url, location.origin);
  const resolved =
    source.artifactShareIdentity ??
    (reference
      ? (
          await accept(
            client(artifactReferencesContract).resolve({
              params: { reference: `${reference.hash}${reference.extension}` },
              fetchOptions: { cache: "no-store" },
            }),
            [200],
          )
        ).body
      : null);
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
  // Permission selection comes from server details, not submitted arguments.
  const persist$ = command(
    async ({ get, set }, audience: Audience, signal: AbortSignal) => {
      const details = await get(details$);
      signal.throwIfAborted();
      if (!details?.status) {
        return false;
      }
      if (
        details.audience === audience &&
        (audience === "private" ||
          details.status.selectedTarget?.id === details.target.id)
      ) {
        return false;
      }
      await accept(
        get(apiClient$)(artifactSharesContract).update({
          body: { target: details.target, audience },
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
      toast.success(
        i18n.t(($) => {
          return $.artifacts.sharing.permissionsUpdated;
        }),
      );
      return true;
    },
  );
  return { change$: persist$ };
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
  const linkCopy = createShareLinkCopy();
  const close$ = command(({ set }) => {
    set(open$, false);
    set(resetOpenSignal$);
    set(linkCopy.clear$);
  });
  const show$ = command(
    async (
      { get, set },
      copyIfReadOnly: boolean,
      parentSignal: AbortSignal,
    ) => {
      const signal = set(resetOpenSignal$, parentSignal);
      set(open$, true);
      const details = await get(details$);
      signal.throwIfAborted();
      if (!details?.status) {
        set(open$, false);
        if (details && copyIfReadOnly) {
          await copyAttachmentLinkToClipboard(
            details.copyUrl,
            undefined,
            signal,
          );
        }
      }
    },
  );
  const copy$ = command(async ({ get, set }, signal: AbortSignal) => {
    const details = await get(details$);
    signal.throwIfAborted();
    if (details?.status) {
      await set(linkCopy.copy$, details.copyUrl, signal);
    }
  });
  const audience = createAudienceSignals(details$, reload$);
  const change$ = throttleCommand(
    command(async ({ set }, choice: Audience, signal: AbortSignal) => {
      set(linkCopy.clear$);
      const updated = await set(audience.change$, choice, signal);
      if (updated) {
        await set(copy$, signal);
      }
    }),
    0,
  );
  return {
    signal$,
    details$,
    open$,
    close$,
    show$,
    copy$,
    copiedUrl$: linkCopy.copiedUrl$,
    change$,
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
        const target = artifactShareTargetSchema.safeParse({
          kind: element.dataset.shareTargetKind,
          id: element.dataset.shareTargetId,
        });
        const source = {
          url,
          copyUrl: element.dataset.copyUrl,
          ...(target.success
            ? {
                artifactShareIdentity: {
                  target: target.data,
                  ...(element.dataset.sharedThreadSnapshot === "true"
                    ? { sharedThreadSnapshot: true as const }
                    : {}),
                },
              }
            : {}),
        };
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
