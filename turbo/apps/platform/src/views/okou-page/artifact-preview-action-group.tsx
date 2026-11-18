import type { ReactNode } from "react";
import type { Computed } from "ccstate";
import { useGet, useLastLoadable } from "ccstate-react";
import { cn } from "@okouai/ui";

import { artifactPreviewDeletionScope } from "../../signals/artifact-deletion.ts";
import { unresolvedArtifactPreviewAction$ } from "../../signals/artifact-preview-actions.ts";
import {
  getArtifactShareScope,
  isShareableArtifactReference,
} from "../../signals/artifact-sharing.ts";
import { getHostedSiteShareScope } from "../../signals/hosted-site-sharing.ts";
import { isHostedSiteUrl } from "../../signals/chat-page/parse-body-blocks.ts";

type ArtifactPreviewActionGroupProps = {
  readonly enabled: boolean;
  readonly artifactId?: string;
  readonly children: ReactNode;
  readonly metadataPending?: boolean;
  readonly shareAvailable: boolean;
  readonly sharePending: boolean;
  readonly shareUrl: string | null | undefined;
  readonly surface: "dialog" | "sidebar";
  readonly url: string;
};

export function ArtifactPreviewActionGroup({
  enabled,
  ...props
}: ArtifactPreviewActionGroupProps) {
  return enabled ? <ReadyArtifactPreviewActions {...props} /> : props.children;
}

function usePreviewActionPending(
  action$: Computed<Promise<unknown>> | undefined,
) {
  const action = useLastLoadable<unknown>(
    action$ ?? unresolvedArtifactPreviewAction$,
  );
  return (
    action.state === "loading" ||
    (action.state === "hasData" && action.data === undefined)
  );
}

function ReadyArtifactPreviewActions({
  artifactId,
  children,
  metadataPending,
  shareAvailable,
  sharePending,
  shareUrl,
  surface,
  url,
}: Omit<ArtifactPreviewActionGroupProps, "enabled">) {
  const deletion = artifactPreviewDeletionScope(surface);
  const deletionSession = useGet(deletion.session$);
  const ownershipPending = usePreviewActionPending(
    artifactId !== undefined && deletionSession?.artifactId === artifactId
      ? deletionSession.detail$
      : undefined,
  );
  const sharing = getArtifactShareScope(surface);
  const shareSession = useGet(sharing.session$);
  const artifactSharePending = usePreviewActionPending(
    shareSession?.source.url === url ? shareSession.details$ : undefined,
  );
  const hostedSite = getHostedSiteShareScope(surface);
  const siteSession = useGet(hostedSite.session$);
  const sitePending = usePreviewActionPending(
    siteSession?.sourceUrl === url ? siteSession.hasSettings$ : undefined,
  );
  const sharingPending =
    shareAvailable &&
    (isShareableArtifactReference(url)
      ? artifactSharePending
      : sharePending ||
        (!!shareUrl && isHostedSiteUrl(shareUrl) && sitePending));
  const pending =
    metadataPending ||
    (artifactId !== undefined && ownershipPending) ||
    sharingPending;

  // Mounted controls own their requests even while the group is hidden.
  return (
    <div
      hidden={pending}
      className={cn("flex items-center gap-1", pending && "hidden")}
    >
      {children}
    </div>
  );
}
