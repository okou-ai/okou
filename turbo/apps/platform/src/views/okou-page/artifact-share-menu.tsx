import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Share2, Users, Globe, Loader2 } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { shareArtifact$ } from "../../signals/artifact-sharing.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { copyAttachmentLinkToClipboard } from "./attachment-url.ts";

export function ArtifactShareMenu({
  url,
  className,
  iconSize = 16,
  ariaLabel,
}: {
  readonly url: string;
  readonly className?: string;
  readonly iconSize?: number;
  readonly ariaLabel?: string;
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const [sharing, share] = useLoadableSet(shareArtifact$);
  const sharingPending = sharing.state === "loading";

  const shareAndCopy = async (audience: "organization" | "public") => {
    const shareUrl = await share({ url, audience }, signal);
    signal.throwIfAborted();
    if (shareUrl) {
      await copyAttachmentLinkToClipboard(shareUrl);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={sharingPending}
        aria-busy={sharingPending ? "true" : undefined}
        aria-label={
          ariaLabel ??
          t(($) => {
            return $.artifacts.actions.share;
          })
        }
        render={<Button variant="quiet" size="icon-sm" className={className} />}
      >
        {sharingPending ? (
          <Loader2 size={iconSize} className="animate-spin" />
        ) : (
          <Share2 size={iconSize} />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem
          disabled={sharingPending}
          onClick={() => {
            detach(
              shareAndCopy("organization"),
              Reason.DomCallback,
              "share artifact to organization",
            );
          }}
        >
          <Users size={14} />
          {t(($) => {
            return $.artifacts.sharing.shareOrganization;
          })}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={sharingPending}
          onClick={() => {
            detach(
              shareAndCopy("public"),
              Reason.DomCallback,
              "share artifact to public",
            );
          }}
        >
          <Globe size={14} />
          {t(($) => {
            return $.artifacts.sharing.sharePublic;
          })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
