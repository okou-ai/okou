import { useGet } from "ccstate-react";
import {
  currentHostedSiteUrl,
  hostedSiteUrlChanges$,
} from "../../signals/hosted-site-url-changes.ts";
import { hostedSiteLink, type ArtifactTitleLink } from "./artifact-display.ts";

/**
 * Keep the display title stable while a public site's link follows URL changes.
 */
export function ArtifactTitle({
  title,
  link,
}: {
  readonly title: string;
  readonly link: ArtifactTitleLink | null;
}) {
  const changes = useGet(hostedSiteUrlChanges$);
  const currentLink = link
    ? hostedSiteLink(currentHostedSiteUrl(link.href, changes))
    : null;
  if (!currentLink) {
    return title;
  }
  return (
    <a
      href={currentLink.href}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:underline"
      data-testid="artifact-title-link"
    >
      {title}
    </a>
  );
}
