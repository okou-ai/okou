import { useGet } from "ccstate-react";
import {
  currentHostedSiteUrl,
  hostedSiteUrlChanges$,
} from "../../signals/hosted-site-url-changes.ts";
import { hostedSiteLink, type ArtifactTitleLink } from "./artifact-display.ts";

/**
 * A public hosted site is identified by its address rather than its entry
 * filename, so the header title becomes a link to the live site.
 */
export function ArtifactTitle({
  filename,
  link,
}: {
  readonly filename: string;
  readonly link: ArtifactTitleLink | null;
}) {
  const changes = useGet(hostedSiteUrlChanges$);
  const currentLink = link
    ? hostedSiteLink(currentHostedSiteUrl(link.href, changes))
    : null;
  if (!currentLink) {
    return filename;
  }
  return (
    <a
      href={currentLink.href}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:underline"
      data-testid="artifact-title-link"
    >
      {currentLink.label}
    </a>
  );
}
