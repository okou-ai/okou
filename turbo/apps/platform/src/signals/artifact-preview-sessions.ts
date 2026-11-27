import { command, type Computed } from "ccstate";
import {
  artifactPreviewDeletionScope,
  type ArtifactDeletionIdentity,
} from "./artifact-deletion.ts";
import {
  getArtifactShareScope,
  isShareableArtifactReference,
  type ArtifactShareSource,
} from "./artifact-sharing.ts";
import { getHostedSiteShareScope } from "./hosted-site-sharing.ts";
import { isHostedSiteUrl } from "./chat-page/parse-body-blocks.ts";
import {
  artifactFavoriteScope,
  type ArtifactFavoriteTarget,
} from "./artifact-favorites.ts";

interface ArtifactPreviewSelection extends ArtifactShareSource {
  readonly deletionIdentity:
    | ArtifactDeletionIdentity
    | Computed<Promise<ArtifactDeletionIdentity | null>>;
  readonly shareAvailable?: boolean;
  readonly managementAvailable?: boolean;
  readonly favoriteTarget?: ArtifactFavoriteTarget;
}

function sameShareSource(
  current: ArtifactShareSource | undefined,
  source: ArtifactShareSource,
) {
  return (
    current?.url === source.url &&
    current.fileId === source.fileId &&
    current.artifactShareIdentity$ === source.artifactShareIdentity$
  );
}

function sameDeletionIdentity(
  current: ArtifactPreviewSelection["deletionIdentity"] | undefined,
  identity: ArtifactPreviewSelection["deletionIdentity"],
) {
  return (
    current === identity ||
    (current &&
      "artifactId" in current &&
      "artifactId" in identity &&
      current.artifactId === identity.artifactId &&
      current.sourceKind === identity.sourceKind)
  );
}

const selectArtifactPreviewFavorite$ = command(
  (
    { get, set },
    surface: "dialog" | "sidebar",
    source: ArtifactPreviewSelection,
    signal: AbortSignal,
  ) => {
    const favorites = artifactFavoriteScope(surface);
    const favoriteSource =
      source.favoriteTarget ??
      (source.shareAvailable !== false ? { url: source.url } : null);
    const currentFavorite = get(favorites.session$)?.source;
    const sameFavorite =
      favoriteSource &&
      currentFavorite &&
      ("artifactId" in favoriteSource && "artifactId" in currentFavorite
        ? favoriteSource.artifactId === currentFavorite.artifactId
        : "url" in favoriteSource &&
          "url" in currentFavorite &&
          favoriteSource.url === currentFavorite.url);
    if (!sameFavorite && (favoriteSource || currentFavorite)) {
      set(favorites.select$, favoriteSource, signal);
    }
  },
);

/** Opening resets the preview owner first; publication updates keep unchanged sessions. */
export const selectArtifactPreviewSessions$ = command(
  (
    { get, set },
    surface: "dialog" | "sidebar",
    source: ArtifactPreviewSelection,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    set(selectArtifactPreviewFavorite$, surface, source, signal);
    const managementAvailable = source.managementAvailable !== false;
    const site = getHostedSiteShareScope(surface);
    const siteSession = get(site.session$);
    if (
      siteSession?.sourceUrl !== (managementAvailable ? source.url : "") &&
      (siteSession || (managementAvailable && isHostedSiteUrl(source.url)))
    ) {
      set(site.select$, managementAvailable ? source.url : "", signal);
    }
    const sharing = getArtifactShareScope(surface);
    const currentShare = get(sharing.session$)?.source;
    const shareable =
      managementAvailable &&
      source.shareAvailable !== false &&
      isShareableArtifactReference(source.url);
    if (shareable) {
      if (!sameShareSource(currentShare, source)) {
        set(
          sharing.select$,
          {
            url: source.url,
            fileId: source.fileId,
            artifactShareIdentity$: source.artifactShareIdentity$,
          },
          signal,
        );
      }
    } else if (currentShare) {
      set(sharing.select$, null, signal);
    }
    const deletion = artifactPreviewDeletionScope(surface);
    const currentDeletion = get(deletion.source$);
    const identity = managementAvailable ? source.deletionIdentity : null;
    if (identity === null) {
      if (currentDeletion) {
        set(deletion.select$, null, signal);
      }
    } else if (!sameDeletionIdentity(currentDeletion?.identity, identity)) {
      set(deletion.select$, identity, signal);
    }
  },
);
