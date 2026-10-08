import type { ArtifactTitleLink } from "./artifact-display.ts";

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
  if (!link) {
    return filename;
  }
  return (
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:underline"
      data-testid="artifact-title-link"
    >
      {link.label}
    </a>
  );
}
