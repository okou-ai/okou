import { ArrowUpRight } from "lucide-react";
import type { ArtifactSubtitleLink } from "./artifact-display.ts";

export function ArtifactSubtitle({
  link,
  text,
}: {
  readonly link: ArtifactSubtitleLink | null;
  readonly text: string;
}) {
  if (!link) {
    return text;
  }
  return (
    <>
      <a
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        className="transition-colors hover:text-foreground hover:underline"
        data-testid="artifact-subtitle-link"
      >
        {link.label}
        <ArrowUpRight size={12} className="ml-0.5 inline align-[-1px]" />
      </a>
      {` · ${text}`}
    </>
  );
}
