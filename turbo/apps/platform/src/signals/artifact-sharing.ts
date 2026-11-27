import { createSharePeopleSignals } from "./share-people.ts";
import { command, computed, state, type Computed } from "ccstate";
import { artifactReferencesContract } from "@okouai/api-contracts/client/artifact-references";
import { parseArtifactReference } from "@okouai/api-contracts/validators/artifact-references";
import { artifactAccessContract } from "@okouai/api-contracts/client/artifact-access";
import type { ArtifactVisibilityResponse } from "@okouai/api-contracts/contracts/artifact-access";
import type {
  ArtifactShareStatus,
  ArtifactShareTarget,
} from "@okouai/api-contracts/contracts/artifact-shares";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../i18n/index.ts";
import { accept } from "../lib/accept.ts";
import { copyAttachmentLinkToClipboard } from "../views/okou-page/attachment-url.ts";
import { apiClient$, type ApiClientFactory } from "./api-client.ts";
import type { ArtifactShareIdentity } from "./attachment-resource-url.ts";
import { authenticatedWebFile } from "../lib/message-url.ts";
import { createShareLinkCopy } from "./share-link-copy.ts";
import { resetSignal, throttleCommand } from "./utils.ts";

// Hosted sites are public publications addressed by their own URL, so the
// viewer offers their link instead of an artifact permission control.
function artifactSharingTarget(url: string): ArtifactShareTarget | null {
  const file = authenticatedWebFile(url);
  return file ? { kind: "file", id: file.id } : null;
}

export function isShareableArtifactReference(url: string): boolean {
  return (
    parseArtifactReference(url, location.origin) !== null ||
    artifactSharingTarget(url) !== null
  );
}

export interface ArtifactShareSource {
  readonly url: string;
  readonly copyUrl?: string;
  /** Canonical artifact ID when already known (e.g. catalog detail). */
  readonly artifactId?: string;
  /** A catalog publication replacing its file needs a fresh permission read. */
  readonly fileId?: string;
  readonly artifactShareIdentity$?: Computed<
    Promise<ArtifactShareIdentity | null>
  >;
}
type Audience = ArtifactShareStatus["audience"];

function visibilityToShareStatus(
  target: ArtifactShareTarget,
  response: ArtifactVisibilityResponse,
): ArtifactShareStatus {
  return {
    ownerUrl: response.ownerUrl,
    shareId: null,
    audience: response.visibility,
    organization: response.organization,
    selectedTarget: response.visibility === "private" ? null : target,
    selectedVersion: null,
    candidateVersion: null,
    url: response.shareUrl,
    shortUrl: response.shortUrl,
  };
}

function ownedShareDetails(
  target: ArtifactShareTarget,
  artifactId: string,
  status: ArtifactShareStatus,
  fragment: string,
) {
  const copyUrl = new URL(status.ownerUrl, location.origin);
  copyUrl.hash = fragment;
  const audience =
    status.selectedTarget && status.selectedTarget.id !== target.id
      ? "private"
      : status.audience;
  return {
    target,
    artifactId,
    status,
    audience,
    copyUrl: copyUrl.href,
  } as const;
}

async function loadShareDetails(
  client: ApiClientFactory,
  source: ArtifactShareSource,
  identity: ArtifactShareIdentity | undefined,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const reference = parseArtifactReference(source.url, location.origin);
  const resolved =
    identity ??
    (reference
      ? (
          await accept(
            client(artifactReferencesContract).resolve({
              params: { reference: `${reference.hash}${reference.extension}` },
              fetchOptions: { cache: "no-store", signal },
            }),
            [200],
            signal,
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
      artifactId: target.id,
      status: null,
      audience: undefined,
      copyUrl: new URL(source.copyUrl ?? source.url, location.origin).href,
    };
  }
  // Viewing access does not imply ownership. Only this endpoint authorizes the
  // permission controls; its 404 response identifies a read-only recipient.
  const queryArtifactId = source.artifactId ?? target.id;
  const result = await accept(
    client(artifactAccessContract).getVisibility({
      params: { artifactId: queryArtifactId },
      fetchOptions: { signal, cache: "no-store" },
    }),
    [200, 404],
    signal,
  );
  if (result.status === 200) {
    return ownedShareDetails(
      target,
      result.body.artifactId,
      visibilityToShareStatus(target, result.body),
      reference?.fragment ?? "",
    );
  }
  return {
    target,
    artifactId: queryArtifactId,
    status: null,
    audience: undefined,
    copyUrl: new URL(source.copyUrl ?? source.url, location.origin).href,
  };
}
type ShareDetails = Awaited<ReturnType<typeof loadShareDetails>>;

function createAudienceSignals(source: ArtifactShareSource) {
  const request$ = state<
    | ((
        client: ApiClientFactory,
        identity: ArtifactShareIdentity | undefined,
      ) => Promise<ShareDetails>)
    | null
  >(null);
  const initialRead$ = computed(async (get) => {
    const request = get(request$);
    if (!request) {
      return null;
    }
    const identity = source.artifactShareIdentity$
      ? ((await get(source.artifactShareIdentity$)) ?? undefined)
      : undefined;
    return request(get(apiClient$), identity);
  });
  const initialize$ = command(({ set }, signal: AbortSignal) => {
    set(request$, () => {
      return (
        client: ApiClientFactory,
        identity: ArtifactShareIdentity | undefined,
      ) => {
        return loadShareDetails(client, source, identity, signal);
      };
    });
  });
  // A saved response belongs to the same source and client as its initial read.
  const saved$ = state<{
    readonly initialRead: Promise<ShareDetails>;
    readonly details: ReturnType<typeof ownedShareDetails>;
  } | null>(null);
  const details$ = computed((get) => {
    const initialRead = get(initialRead$);
    const saved = get(saved$);
    return saved?.initialRead === initialRead
      ? Promise.resolve(saved.details)
      : initialRead;
  });
  // The last submitted choice. Views read it only while the save is in
  // flight, so the control keeps the new choice instead of clearing, and a
  // failed save falls back to the server value.
  const pending$ = state<Audience | null>(null);
  // Permission selection comes from server details, not submitted arguments.
  const persist$ = command(
    async ({ get, set }, audience: Audience, signal: AbortSignal) => {
      const initialRead = get(initialRead$);
      const details = await get(details$);
      signal.throwIfAborted();
      if (!details?.status || get(initialRead$) !== initialRead) {
        return;
      }
      if (
        details.audience === audience &&
        (audience === "private" ||
          details.status.selectedTarget?.id === details.target.id)
      ) {
        return;
      }
      const updated = await accept(
        get(apiClient$)(artifactAccessContract).updateVisibility({
          params: { artifactId: details.artifactId },
          body: { visibility: audience },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      signal.throwIfAborted();
      set(saved$, {
        initialRead,
        details: ownedShareDetails(
          details.target,
          updated.body.artifactId,
          visibilityToShareStatus(details.target, updated.body),
          new URL(details.copyUrl).hash,
        ),
      });
      toast.success(
        i18n.t(($) => {
          return $.artifacts.sharing.permissionsUpdated;
        }),
      );
    },
  );
  return { details$, pending$, change$: persist$, initialize$ };
}

function createArtifactShareSession(source: ArtifactShareSource) {
  // The preview owner installs its live signal after this graph is constructed.
  const signal$ = state<AbortSignal | null>(null);
  const {
    details$,
    pending$: pendingAudience$,
    change$: persist$,
    initialize$,
  } = createAudienceSignals(source);
  const open$ = state(false);
  const peopleTarget$ = computed(async (get) => {
    const details = await get(details$);
    return details?.status && details.target.kind === "file"
      ? { artifactId: details.artifactId }
      : null;
  });
  const people = createSharePeopleSignals(peopleTarget$);
  const resetOpenSignal$ = resetSignal();
  const linkCopy = createShareLinkCopy();
  const close$ = command(({ set }) => {
    set(open$, false);
    set(people.setSearchOpen$, false);
    set(resetOpenSignal$);
    set(linkCopy.clear$);
  });
  const show$ = command(async ({ get, set }, parentSignal: AbortSignal) => {
    const signal = set(resetOpenSignal$, parentSignal);
    set(people.open$, signal);
    set(open$, true);
    const details = await get(details$);
    signal.throwIfAborted();
    if (!details?.status) {
      set(open$, false);
      if (details) {
        await copyAttachmentLinkToClipboard(details.copyUrl, undefined, signal);
      }
    }
  });
  const copy$ = command(async ({ get, set }, signal: AbortSignal) => {
    const details = await get(details$);
    signal.throwIfAborted();
    if (details?.status) {
      await set(linkCopy.copy$, details.copyUrl, signal);
    }
  });
  const throttledChange$ = throttleCommand(
    command(({ set }, choice: Audience, signal: AbortSignal) => {
      set(linkCopy.clear$);
      return set(persist$, choice, signal);
    }),
    0,
  );
  // Records the choice before throttling, so a click queued behind an
  // in-flight save is what the control shows.
  const change$ = command(({ set }, choice: Audience, signal: AbortSignal) => {
    set(pendingAudience$, choice);
    return set(throttledChange$, choice, signal);
  });
  return {
    source,
    initialize$,
    signal$,
    details$,
    pendingAudience$,
    open$,
    close$,
    show$,
    copy$,
    copiedUrl$: linkCopy.copiedUrl$,
    people,
    peopleInputId: `artifact-people-${crypto.randomUUID()}`,
    change$,
  };
}
export type ArtifactShareSession = ReturnType<
  typeof createArtifactShareSession
>;

function createArtifactShareScope() {
  const source$ = state<ArtifactShareSource | null>(null);
  const session$ = computed((get) => {
    const source = get(source$);
    return source ? createArtifactShareSession(source) : null;
  });
  const resetSession$ = resetSignal();
  const select$ = command(
    (
      { get, set },
      source: ArtifactShareSource | null,
      parentSignal: AbortSignal,
    ) => {
      parentSignal.throwIfAborted();
      const signal = set(resetSession$, parentSignal);
      if (!source || !isShareableArtifactReference(source.url)) {
        set(source$, null);
        return;
      }
      set(source$, source);
      const session = get(session$)!;
      set(session.signal$, signal);
      set(session.initialize$, signal);
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

// These are the three existing singleton preview surfaces, not a URL cache.
const shareScopes = Object.freeze({
  dialog: createArtifactShareScope(),
  sidebar: createArtifactShareScope(),
  viewer: createArtifactShareScope(),
});
export function getArtifactShareScope(surface: keyof typeof shareScopes) {
  return shareScopes[surface];
}
