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

interface ArtifactPreviewSelection extends ArtifactShareSource {
  readonly deletionIdentity:
    | ArtifactDeletionIdentity
    | Computed<Promise<ArtifactDeletionIdentity | null>>;
  readonly shareAvailable?: boolean;
}

function sameShareSource(
  current: ArtifactShareSource | undefined,
  source: ArtifactShareSource,
) {
  return (
    current?.url === source.url &&
    current.artifactId === source.artifactId &&
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

/** Opening resets the preview owner first; publication updates keep unchanged sessions. */
export const selectArtifactPreviewSessions$ = command(
  (
    { get, set },
    surface: "dialog" | "sidebar",
    source: ArtifactPreviewSelection,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const site = getHostedSiteShareScope(surface);
    const siteSession = get(site.session$);
    if (
      siteSession?.sourceUrl !== source.url &&
      (siteSession || isHostedSiteUrl(source.url))
    ) {
      set(site.select$, source.url, signal, source.artifactId);
    }
    const sharing = getArtifactShareScope(surface);
    const currentShare = get(sharing.session$)?.source;
    const shareable =
      source.shareAvailable !== false &&
      isShareableArtifactReference(source.url);
    if (shareable) {
      if (!sameShareSource(currentShare, source)) {
        set(
          sharing.select$,
          {
            url: source.url,
            artifactId: source.artifactId,
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
    const identity = source.deletionIdentity;
    if (!sameDeletionIdentity(currentDeletion?.identity, identity)) {
      set(deletion.select$, identity, signal);
    }
  },
);
