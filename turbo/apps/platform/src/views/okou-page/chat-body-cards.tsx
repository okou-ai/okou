import { withChatScrollLayout } from "../components/chat-scroll-layout.tsx";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { now } from "../../lib/time.ts";
import { runChatActionCallback$ } from "../../signals/chat-page/action-callback.ts";
import type { ArtifactSignals } from "../../signals/chat-page/artifact-card-signals.ts";
import type { ComputerUseAuthorizationSignals } from "../../signals/chat-page/computer-use-authorization-block.ts";
import type {
  CatalogConnectorSignals,
  ConnectorSignals,
  CustomConnectorSignals,
} from "../../signals/chat-page/connector-action-block.ts";
import { contentTypeForBodyPreviewKind } from "../../signals/chat-page/parse-body-blocks.ts";
import type { PermissionSignals } from "../../signals/chat-page/permission-card-signals.ts";
import type { PlanUpgradeSignals } from "../../signals/chat-page/plan-upgrade-block.ts";
import type {
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../../signals/connector-domain.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  applyUserPermissionGrant$,
  findPermissionInMetadata,
  resolveUserPermissionGrantPolicy,
} from "../../signals/permission-allow/permission-allow-signals.ts";
import {
  DEFAULT_USER_PERMISSION_GRANT_EXPIRES_IN,
  permissionGrantExpiresInByScope$,
  setPermissionGrantExpiresIn$,
} from "../../signals/permission-allow/permission-grant-expiration.ts";
import { isActiveUserPermissionGrant } from "../../signals/user-permission-grants.ts";
import { Reason, detach } from "../../signals/utils.ts";
import type { ImageLoadSignals } from "../../signals/image-load.ts";
import { connectorCurrentConnectionStatus } from "../../signals/okou-page/settings/connectors.ts";
import { PermissionGrantDurationSelect } from "../components/permission-grant-duration-select.tsx";
import { ConnectorCard } from "./components/settings/connector-card.tsx";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { CustomConnectorIcon } from "./components/settings/custom-connector-icon.tsx";
import { ArtifactThumbnailImage } from "./artifact-thumbnail.tsx";
import { AttachmentPreview } from "./attachment-preview.tsx";
import { publicAttachmentUrl } from "./attachment-url";
import type { UserPermissionGrantExpiresIn } from "@okouai/api-contracts/contracts/user-permission-grants";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicyValue,
} from "@okouai/connectors/firewall-contracts";
import { Button, Skeleton, cn } from "@okouai/ui";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  AlertCircle,
  ArrowUpRight,
  Coins,
  Image,
  Loader2,
  Monitor,
  Play,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { MarkdownCardRef } from "../../signals/chat-page/markdown-card-ref.ts";
import {
  openFileLightbox$ as openAttachmentFileLightbox$,
  openImageLightbox$ as openAttachmentImageLightbox$,
  openVideoLightbox$ as openAttachmentVideoLightbox$,
} from "../../signals/okou-page/attachment-chips.ts";
import { BrowserSessionCard } from "./browser-session-card.tsx";
import { BankingActionCard } from "./banking-action-card.tsx";
import { ConnectorAccountActionCard } from "./connector-account-action-card.tsx";
import { MailDraftCard } from "./mail-draft-card.tsx";

type ChatImagePreviewLinkProps = {
  alt: string;
  ariaLabel: string;
  imageClassName: string;
  linkClassName: string;
  load: ImageLoadSignals;
  onPreview: () => void;
  placeholderClassName: string;
  resourceUrl$: ArtifactSignals["resourceUrl$"];
  thumbnailUrl$: ArtifactSignals["thumbnailUrl$"];
  url: string;
};

const CHAT_INLINE_MEDIA_PREVIEW_CHROME_CLASS = cn(
  "border border-foreground/10 transition-all duration-200",
  "hover:scale-[1.015] hover:border-foreground/20",
);

const CHAT_INLINE_MEDIA_THUMBNAIL_PREVIEW_CLASS = cn(
  "aspect-[10/9] w-[50px] max-w-full cursor-pointer rounded-lg",
  CHAT_INLINE_MEDIA_PREVIEW_CHROME_CLASS,
);
export const CHAT_INLINE_IMAGE_PREVIEW_CLASS = cn(
  CHAT_INLINE_MEDIA_THUMBNAIL_PREVIEW_CLASS,
  "bg-muted/30",
);
export const CHAT_INLINE_VIDEO_ATTACHMENT_PREVIEW_CLASS = cn(
  CHAT_INLINE_MEDIA_THUMBNAIL_PREVIEW_CLASS,
  "bg-black",
);
const CHAT_INLINE_VIDEO_BODY_PREVIEW_CLASS = cn(
  "aspect-[16/10] w-[min(100%,400px)] max-w-full cursor-pointer rounded-lg",
  CHAT_INLINE_MEDIA_PREVIEW_CHROME_CLASS,
  "bg-black",
);

export function ChatImagePreviewLink({
  alt,
  ariaLabel,
  imageClassName,
  linkClassName,
  load,
  onPreview,
  placeholderClassName,
  resourceUrl$,
  thumbnailUrl$,
  url,
}: ChatImagePreviewLinkProps) {
  const imageStatus = useGet(load.status$);
  const markLoaded = useSet(load.loaded$);
  const markFailed = useSet(load.failed$);
  const imageUrl = publicAttachmentUrl(url);
  const resourceUrl = useLastResolved(resourceUrl$) ?? null;
  const previewImageUrl = useLastResolved(thumbnailUrl$) ?? null;

  const showPlaceholder = imageStatus !== "loaded";

  const openPreview = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    ) {
      return;
    }
    event.preventDefault();
    onPreview();
  };

  return (
    <a
      href={resourceUrl ?? imageUrl}
      onClick={openPreview}
      className={cn(
        "group/image-preview inline-grid self-start grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] align-top overflow-hidden",
        linkClassName,
      )}
      aria-label={ariaLabel}
    >
      {showPlaceholder && (
        <span
          data-testid="chat-image-preview-loading"
          className={cn(
            "col-start-1 row-start-1 z-10 flex min-h-0 min-w-0 items-center justify-center bg-muted/70 text-muted-foreground",
            placeholderClassName,
          )}
        >
          {imageStatus === "loading" ? (
            <Loader2 size={18} className="animate-spin" />
          ) : (
            <Image size={18} />
          )}
        </span>
      )}
      {previewImageUrl !== null ? (
        <img
          key={previewImageUrl}
          src={previewImageUrl}
          alt={alt}
          loading="lazy"
          onLoad={markLoaded}
          onError={markFailed}
          className={cn(
            "col-start-1 row-start-1 min-h-0 min-w-0",
            imageClassName,
            showPlaceholder && "opacity-0",
          )}
        />
      ) : null}
    </a>
  );
}

type ChatVideoPreviewButtonProps = {
  resourceUrl$: ArtifactSignals["resourceUrl$"];
  ariaLabel: string;
  buttonClassName: string;
  filename: string;
  onPreview: () => void;
  posterClassName: string;
  posterLoad: ImageLoadSignals;
  previewImagePending?: boolean;
  previewImageUrl?: string;
  videoClassName: string;
};

function videoPosterFrameUrl(url: string): string {
  const hashIndex = url.indexOf("#");
  const urlWithoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  return `${urlWithoutHash}#t=0.001`;
}

export function ChatVideoPreviewButton({
  resourceUrl$,
  ariaLabel,
  buttonClassName,
  filename,
  onPreview,
  posterClassName,
  posterLoad,
  previewImagePending,
  previewImageUrl,
  videoClassName,
}: ChatVideoPreviewButtonProps) {
  const videoUrl = useLastResolved(resourceUrl$) ?? null;
  const posterVideoUrl =
    videoUrl === null ? undefined : videoPosterFrameUrl(videoUrl);
  const videoFallback = (
    <video
      src={posterVideoUrl}
      preload="metadata"
      muted
      playsInline
      aria-hidden="true"
      className={cn("absolute inset-0", videoClassName)}
      data-testid="chat-video-preview-fallback"
    />
  );

  return (
    <button
      type="button"
      onClick={onPreview}
      title={filename}
      aria-label={ariaLabel}
      className={cn(
        "group/video-preview relative inline-flex items-center justify-center overflow-hidden",
        buttonClassName,
      )}
    >
      <span
        data-testid="chat-video-preview-poster"
        className={cn("block bg-black", posterClassName)}
      />
      {previewImageUrl ? (
        <ArtifactThumbnailImage
          src={previewImageUrl}
          load={posterLoad}
          testId="chat-video-preview-thumbnail"
          className={cn("absolute inset-0", videoClassName)}
          fallback={videoFallback}
        />
      ) : previewImagePending ? null : (
        videoFallback
      )}
      <span className="absolute inset-0 flex items-center justify-center bg-black/10 transition-colors group-hover/video-preview:bg-black/35">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white shadow-lg transition-transform group-hover/video-preview:scale-105">
          <Play size={17} />
        </span>
      </span>
    </button>
  );
}

/**
 * Renders action slots and explicit artifact preview cards. Artifact links and
 * image tiles keep their own Markdown renderers while sharing these signals.
 */
export function MarkdownCardView({
  card,
  label,
}: {
  card: MarkdownCardRef;
  label?: string;
}) {
  switch (card.kind) {
    case "artifact": {
      return (
        <ArtifactCardView
          signals={card.signals}
          threadId={card.threadId}
          label={label}
        />
      );
    }
    case "connector-action": {
      return <ConnectorActionCard signals={card.signals} />;
    }
    case "connector-account-action": {
      return <ConnectorAccountActionCard signals={card.signals} />;
    }
    case "permission-action": {
      return <PermissionActionCard signals={card.signals} />;
    }
    case "banking-action": {
      return <BankingActionCard signals={card.signals} />;
    }
    case "unavailable-action": {
      return <UnavailableActionCard />;
    }
    case "computer-use-authorization": {
      return <ComputerUseAuthorizationCard signals={card.signals} />;
    }
    case "plan-upgrade": {
      return <PlanUpgradeCard signals={card.signals} />;
    }
    case "mail-draft": {
      return <MailDraftCard signals={card.signals} />;
    }
    case "browser-session": {
      return <BrowserSessionCard signals={card.signals} />;
    }
  }
}

function ArtifactCardView({
  signals,
  threadId,
  label,
}: {
  signals: ArtifactSignals;
  threadId: string;
  label?: string;
}) {
  const { t } = useTranslation();
  const openFileLightbox = useSet(openAttachmentFileLightbox$);
  const openImageLightbox = useSet(openAttachmentImageLightbox$);
  const openVideoLightbox = useSet(openAttachmentVideoLightbox$);
  const openLightbox = (url: string): void => {
    openImageLightbox({
      threadId,
      url,
      filename: signals.filename,
      preview: signals,
    });
  };
  const previewImageLoadable = useLastLoadable(signals.previewImageUrl$);
  const previewImagePending = previewImageLoadable.state === "loading";
  const previewImageUrl =
    previewImageLoadable.state === "hasData"
      ? previewImageLoadable.data
      : undefined;

  if (signals.kind === "image") {
    return withChatScrollLayout(
      <ChatImagePreviewLink
        alt={signals.filename}
        ariaLabel={t(
          ($) => {
            return $.chat.attachments.previewFile;
          },
          {
            filename: signals.filename,
          },
        )}
        imageClassName="block h-full w-full object-contain"
        linkClassName={CHAT_INLINE_IMAGE_PREVIEW_CLASS}
        onPreview={() => {
          openLightbox(signals.url);
        }}
        load={signals.previewImageLoad}
        placeholderClassName="h-full w-full"
        resourceUrl$={signals.resourceUrl$}
        thumbnailUrl$={signals.thumbnailUrl$}
        url={signals.url}
      />,
    );
  }
  if (signals.kind === "video") {
    return withChatScrollLayout(
      <ChatVideoPreviewButton
        resourceUrl$={signals.resourceUrl$}
        ariaLabel={t(
          ($) => {
            return $.chat.attachments.previewFile;
          },
          {
            filename: signals.filename,
          },
        )}
        buttonClassName={CHAT_INLINE_VIDEO_BODY_PREVIEW_CLASS}
        filename={signals.filename}
        onPreview={() => {
          openVideoLightbox({
            url: signals.url,
            filename: signals.filename,
          });
        }}
        posterClassName="h-full w-full"
        posterLoad={signals.previewImageLoad}
        previewImagePending={previewImagePending}
        previewImageUrl={previewImageUrl}
        videoClassName="h-full w-full object-contain"
      />,
    );
  }
  return withChatScrollLayout(
    <AttachmentPreview
      resourceUrl$={signals.resourceUrl$}
      attachment={{
        filename: signals.kind === "html" && label ? label : signals.filename,
        url: signals.url,
        contentType: contentTypeForBodyPreviewKind(signals.kind),
        ...(previewImagePending ? { previewImagePending: true } : {}),
        ...(previewImageUrl ? { previewImageUrl } : {}),
      }}
      onPreviewFile={() => {
        openFileLightbox({
          filename: signals.filename,
          url: signals.url,
        });
      }}
      previewImageLoad={signals.previewImageLoad}
      text$={signals.text$}
    />,
  );
}

const CHAT_CONNECTOR_ACTION_CARD_HEIGHT_CLASS = "h-[136px] sm:h-[88px]";

function UnavailableActionCard() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="unavailable-action-card"
      className="okou-chat-card flex min-h-[88px] w-full items-center gap-3 p-3 text-left"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40 text-muted-foreground">
        <AlertCircle size={22} />
      </div>
      <div className="min-w-0">
        <div className="text-[0.9375rem] font-medium text-foreground">
          {t(($) => {
            return $.chat.actionUnavailable.title;
          })}
        </div>
        <div className="mt-0.5 text-sm leading-5 text-muted-foreground">
          {t(($) => {
            return $.chat.actionUnavailable.description;
          })}
        </div>
      </div>
    </div>
  );
}

function ConnectorActionCardSkeleton() {
  return (
    <Skeleton
      data-testid="connector-action-card-loading"
      className={cn(
        "w-full rounded-[var(--okou-card-radius)]",
        CHAT_CONNECTOR_ACTION_CARD_HEIGHT_CLASS,
      )}
    />
  );
}

function CatalogConnectorActionCard({
  signals,
}: {
  signals: CatalogConnectorSignals;
}) {
  const pageSignal = useGet(pageSignal$);
  const catalogItemLoadable = useLastLoadable(signals.catalogItem$);
  const catalogItem = useLastResolved(signals.catalogItem$);
  const connected = useLastResolved(signals.connected$) ?? false;
  const completeLoadable = useLoadable(signals.complete$);
  const complete =
    completeLoadable.state === "hasData" && completeLoadable.data;
  const [activateLoadable, activate] = useLoadableSet(signals.activate$);
  const loading =
    completeLoadable.state === "loading" ||
    activateLoadable.state === "loading";
  if (!catalogItem && catalogItemLoadable.state === "loading") {
    return withChatScrollLayout(<ConnectorActionCardSkeleton />);
  }
  if (!catalogItem) {
    return withChatScrollLayout(null);
  }

  return withChatScrollLayout(
    <ConnectorCard
      variant="action"
      className={cn(
        "justify-between overflow-hidden",
        CHAT_CONNECTOR_ACTION_CARD_HEIGHT_CLASS,
      )}
      icon={<ConnectorIcon icon={catalogItem.icon} size={22} />}
      label={catalogItem.label}
      description={catalogItem.description}
      connected={connected}
      complete={complete}
      reconnectRequired={
        connectorCurrentConnectionStatus(catalogItem) === "reconnect-required"
      }
      busy={loading}
      onActivate={() => {
        detach(activate(pageSignal), Reason.DomCallback);
      }}
    />,
  );
}

function CustomConnectorActionCard({
  signals,
}: {
  signals: CustomConnectorSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const connectorLoadable = useLastLoadable(signals.connector$);
  const connector = useLastResolved(signals.connector$);
  const connected = useLastResolved(signals.connected$) ?? false;
  const completeLoadable = useLoadable(signals.complete$);
  const complete =
    completeLoadable.state === "hasData" && completeLoadable.data;
  const [activateLoadable, activate] = useLoadableSet(signals.activate$);
  const loading =
    completeLoadable.state === "loading" ||
    activateLoadable.state === "loading";
  if (!connector && connectorLoadable.state === "loading") {
    return withChatScrollLayout(<ConnectorActionCardSkeleton />);
  }
  if (!connector) {
    return withChatScrollLayout(null);
  }

  return withChatScrollLayout(
    <ConnectorCard
      variant="action"
      className={cn(
        "justify-between overflow-hidden",
        CHAT_CONNECTOR_ACTION_CARD_HEIGHT_CLASS,
      )}
      icon={
        <CustomConnectorIcon
          id={connector.id}
          displayName={connector.displayName}
          size={22}
        />
      }
      label={connector.displayName}
      description={t(($) => {
        return $.chat.connectors.customAuthorizeDescription;
      })}
      connected={connected}
      complete={complete}
      reconnectRequired={false}
      busy={loading}
      onActivate={() => {
        detach(activate(pageSignal), Reason.DomCallback);
      }}
    />,
  );
}

function ConnectorActionCard({ signals }: { signals: ConnectorSignals }) {
  return signals.kind === "catalog" ? (
    <CatalogConnectorActionCard signals={signals} />
  ) : (
    <CustomConnectorActionCard signals={signals} />
  );
}

function ComputerUseAuthorizationCard({
  signals,
}: {
  signals: ComputerUseAuthorizationSignals;
}) {
  const { t } = useTranslation();
  return withChatScrollLayout(
    <div
      data-testid="computer-use-authorization-card"
      className="okou-chat-card flex min-h-[88px] w-full flex-col gap-3 p-3 text-left sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
          <Monitor size={22} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[0.9375rem] font-medium text-foreground">
            {t(($) => {
              return $.chat.computerUse.authorization;
            })}
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
            {t(($) => {
              return $.chat.computerUse.authorizationDescription;
            })}
          </div>
        </div>
      </div>
      <a
        href={signals.href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-9 w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-[0.9375rem] font-medium text-foreground transition-colors hover:bg-state-hover sm:w-auto"
      >
        {t(($) => {
          return $.chat.actions.authorize;
        })}
        <ArrowUpRight size={15} />
      </a>
    </div>,
  );
}

function PlanUpgradeCard({ signals }: { signals: PlanUpgradeSignals }) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const open = useSet(signals.open$);

  const handleClick = () => {
    detach(open(pageSignal), Reason.DomCallback);
  };

  return withChatScrollLayout(
    <div
      data-testid="plan-upgrade-card"
      className="okou-chat-card flex min-h-[88px] w-full flex-col gap-3 p-3 text-left sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
          <Coins size={22} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[0.9375rem] font-medium text-foreground">
            {t(($) => {
              return $.chat.billing.upgradeWorkspace;
            })}
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
            {t(($) => {
              return $.chat.billing.comparePlansDescription;
            })}
          </div>
        </div>
      </div>
      <Button
        type="button"
        onClick={handleClick}
        className="w-full shrink-0 sm:w-auto"
      >
        {t(($) => {
          return $.chat.billing.comparePlans;
        })}
      </Button>
    </div>,
  );
}

type PermissionAction = "allow" | "deny";

type PermissionActionUserGrant = PlatformUserPermissionGrant;

type PermissionActionCardStatus =
  | { kind: "loading" }
  | { kind: "load-error" }
  | { kind: "save-error" }
  | { kind: "ready" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "already-applied" }
  | { kind: "missing-target" }
  | { kind: "missing-permission" };

interface LoadableLike<T> {
  state: string;
  data?: T;
}

type ApplyUserPermissionGrantFn = (
  params: {
    agentId?: string;
    workflowId?: string;
    connectorSlug: string;
    permission: string;
    action: PermissionAction;
    expiresIn?: UserPermissionGrantExpiresIn;
  },
  signal: AbortSignal,
) => Promise<PlatformUserPermissionGrant>;

function loadableData<T>(loadable: LoadableLike<T>): T | undefined {
  return loadable.state === "hasData" ? loadable.data : undefined;
}

function permissionActionVerb(action: PermissionAction): string {
  return action === "allow"
    ? i18n.t(($) => {
        return $.chat.permissions.allow;
      })
    : i18n.t(($) => {
        return $.chat.permissions.deny;
      });
}

function permissionActionPermissionLabel(
  permission: { name: string } | undefined,
  fallback: string,
): string {
  const permissionName = permission?.name ?? fallback;
  if (permissionName === UNKNOWN_PERMISSION_GRANT) {
    return i18n.t(($) => {
      return $.chat.permissions.otherEndpoints;
    });
  }
  return permissionName;
}

function permissionActionStatusText(
  status: PermissionActionCardStatus,
  action: "allow" | "deny",
): { label: string; className: string } | null {
  if (status.kind === "saved") {
    return action === "allow"
      ? {
          label: i18n.t(($) => {
            return $.chat.permissions.updated;
          }),
          className: "text-green-600",
        }
      : {
          label: i18n.t(($) => {
            return $.chat.permissions.denied;
          }),
          className: "text-destructive",
        };
  }
  if (status.kind === "already-applied") {
    return action === "allow"
      ? {
          label: i18n.t(($) => {
            return $.chat.permissions.alreadyAllowed;
          }),
          className: "text-green-600",
        }
      : {
          label: i18n.t(($) => {
            return $.chat.permissions.alreadyDenied;
          }),
          className: "text-destructive",
        };
  }
  return null;
}

function PermissionActionButton({
  status,
  onClick,
}: {
  status: PermissionActionCardStatus;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  if (
    status.kind !== "ready" &&
    status.kind !== "saving" &&
    status.kind !== "save-error"
  ) {
    return null;
  }

  const saving = status.kind === "saving";
  return (
    <button
      type="button"
      disabled={saving}
      onClick={onClick}
      className="inline-flex h-9 w-full min-w-0 flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-[0.9375rem] font-medium text-foreground transition-colors hover:bg-state-hover sm:w-auto sm:flex-none"
    >
      {saving && <Loader2 size={15} className="animate-spin" />}
      {saving
        ? t(($) => {
            return $.chat.actions.saving;
          })
        : t(($) => {
            return $.chat.actions.confirm;
          })}
    </button>
  );
}

function PermissionActionTerminalStatus({
  status,
  action,
}: {
  status: PermissionActionCardStatus;
  action: "allow" | "deny";
}) {
  const text = permissionActionStatusText(status, action);
  if (!text) {
    return null;
  }
  return (
    <span className={`shrink-0 text-[0.9375rem] font-medium ${text.className}`}>
      {text.label}
    </span>
  );
}

function PermissionActionInlineStatus({
  status,
}: {
  status: PermissionActionCardStatus;
}) {
  const { t } = useTranslation();
  switch (status.kind) {
    case "loading": {
      return (
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          <span>
            {t(($) => {
              return $.chat.permissions.checking;
            })}
          </span>
        </div>
      );
    }
    case "load-error": {
      return (
        <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-destructive">
          <AlertCircle size={13} />
          <span>
            {t(($) => {
              return $.chat.permissions.loadFailed;
            })}
          </span>
        </div>
      );
    }
    case "save-error": {
      return (
        <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-destructive">
          <AlertCircle size={13} />
          <span>
            {t(($) => {
              return $.chat.permissions.updateFailed;
            })}
          </span>
        </div>
      );
    }
    case "missing-target": {
      return (
        <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-destructive">
          <AlertCircle size={13} />
          <span>
            {t(($) => {
              return $.chat.permissions.agentNotFound;
            })}
          </span>
        </div>
      );
    }
    case "missing-permission": {
      return (
        <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-destructive">
          <AlertCircle size={13} />
          <span>
            {t(($) => {
              return $.chat.permissions.unknown;
            })}
          </span>
        </div>
      );
    }
    case "ready":
    case "saving":
    case "saved":
    case "already-applied": {
      return null;
    }
  }
}

function permissionActionHasControls(
  status: PermissionActionCardStatus,
): boolean {
  switch (status.kind) {
    case "loading":
    case "save-error":
    case "ready":
    case "saving":
    case "saved":
    case "already-applied": {
      return true;
    }
    case "load-error":
    case "missing-target":
    case "missing-permission": {
      return false;
    }
  }
}

function isPermissionActionLoading(params: {
  agentLoading: boolean;
  permissionMetadataLoading: boolean;
  userGrantsLoading: boolean;
}): boolean {
  return (
    params.agentLoading ||
    params.permissionMetadataLoading ||
    params.userGrantsLoading
  );
}

function isPermissionActionSaving(params: { grantLoading: boolean }): boolean {
  return params.grantLoading;
}

function isPermissionActionLoadError(params: {
  agentError: boolean;
  permissionMetadataError: boolean;
  userGrantsError: boolean;
}): boolean {
  return (
    params.agentError ||
    params.permissionMetadataError ||
    params.userGrantsError
  );
}

function isPermissionActionAlreadyApplied(params: {
  hasAgent: boolean;
  userGrantPolicy: FirewallPolicyValue | undefined;
  action: "allow" | "deny";
}): boolean {
  if (!params.hasAgent) {
    return false;
  }
  return params.userGrantPolicy === params.action;
}

function findPermissionActionPermission(
  block: PermissionSignals,
  metadata: PlatformConnectorPermissionMetadata | undefined,
) {
  return metadata
    ? (findPermissionInMetadata(metadata, block.permission) ?? undefined)
    : undefined;
}

function permissionActionUserGrantPolicy(
  loadable: LoadableLike<readonly PermissionActionUserGrant[]>,
  block: PermissionSignals,
  metadata: PlatformConnectorPermissionMetadata | undefined,
): FirewallPolicyValue | undefined {
  const grants = loadableData(loadable);
  if (!grants || !metadata) {
    return undefined;
  }
  return resolveUserPermissionGrantPolicy(grants, metadata, block.permission);
}

function permissionActionUserGrant(
  loadable: LoadableLike<readonly PermissionActionUserGrant[]>,
  block: PermissionSignals,
): PermissionActionUserGrant | undefined {
  const grants = loadableData(loadable);
  if (!grants) {
    return undefined;
  }
  return grants.find((grant) => {
    return (
      grant.connectorSlug === block.connectorSlug &&
      grant.permission === block.permission &&
      grant.action === block.action
    );
  });
}

function permissionActionGrantExpiresAt({
  savedGrant,
  savedGrantActive,
  existingGrant,
  existingGrantActive,
  status,
}: {
  savedGrant: PermissionActionUserGrant | null;
  savedGrantActive: boolean;
  existingGrant: PermissionActionUserGrant | undefined;
  existingGrantActive: boolean;
  status: PermissionActionCardStatus;
}): string | null {
  if (savedGrantActive) {
    return savedGrant?.expiresAt ?? null;
  }
  if (existingGrantActive) {
    return existingGrant?.expiresAt ?? null;
  }
  if (status.kind !== "ready") {
    return null;
  }
  return savedGrant?.expiresAt ?? existingGrant?.expiresAt ?? null;
}

function createPermissionActionCardStatus(params: {
  hasAgent: boolean;
  hasPermission: boolean;
  loading: boolean;
  loadError: boolean;
  saving: boolean;
  saveDone: boolean;
  saveError: boolean;
  alreadyApplied: boolean;
}): PermissionActionCardStatus {
  if (params.saving) {
    return { kind: "saving" };
  }
  if (params.saveDone) {
    return { kind: "saved" };
  }
  if (params.loading) {
    return { kind: "loading" };
  }
  if (params.loadError) {
    return { kind: "load-error" };
  }
  if (!params.hasAgent) {
    return { kind: "missing-target" };
  }
  if (!params.hasPermission) {
    return { kind: "missing-permission" };
  }
  if (params.alreadyApplied) {
    return { kind: "already-applied" };
  }
  if (params.saveError) {
    return { kind: "save-error" };
  }
  return { kind: "ready" };
}

function createPermissionActionCardViewState(params: {
  block: PermissionSignals;
  hasAgent: boolean;
  agentLoadableState: string;
  permissionMetadataLoadable: LoadableLike<PlatformConnectorPermissionMetadata | null>;
  userGrantsLoadable: LoadableLike<readonly PermissionActionUserGrant[]>;
  grantLoadableState: string;
  savedGrantActive: boolean;
}) {
  const permissionMetadata =
    params.permissionMetadataLoadable.state === "hasData"
      ? (params.permissionMetadataLoadable.data ?? undefined)
      : undefined;
  const focusedPermission = findPermissionActionPermission(
    params.block,
    permissionMetadata,
  );
  const actionLabel = permissionActionVerb(params.block.action);
  const loading = isPermissionActionLoading({
    agentLoading: params.agentLoadableState === "loading",
    permissionMetadataLoading:
      params.permissionMetadataLoadable.state === "loading",
    userGrantsLoading: params.userGrantsLoadable.state === "loading",
  });
  const loadError = isPermissionActionLoadError({
    agentError: params.agentLoadableState === "hasError",
    permissionMetadataError:
      params.permissionMetadataLoadable.state === "hasError",
    userGrantsError: params.userGrantsLoadable.state === "hasError",
  });
  const saving = isPermissionActionSaving({
    grantLoading: params.grantLoadableState === "loading",
  });
  const saveError = params.grantLoadableState === "hasError";
  const userGrantPolicy = permissionActionUserGrantPolicy(
    params.userGrantsLoadable,
    params.block,
    permissionMetadata,
  );
  const alreadyApplied = isPermissionActionAlreadyApplied({
    hasAgent: params.hasAgent,
    userGrantPolicy,
    action: params.block.action,
  });
  const saveDone =
    params.grantLoadableState === "hasData" && params.savedGrantActive;
  const status = createPermissionActionCardStatus({
    hasAgent: params.hasAgent,
    hasPermission: Boolean(focusedPermission),
    loading,
    loadError,
    saving,
    saveDone,
    saveError,
    alreadyApplied,
  });
  return {
    actionLabel,
    status,
    focusedPermission,
  };
}

function runPermissionAction(params: {
  status: PermissionActionCardStatus;
  runUserGrant: () => void;
}): void {
  if (params.status.kind !== "ready" && params.status.kind !== "save-error") {
    return;
  }

  params.runUserGrant();
}

function createPermissionActionHandler(
  params: {
    block: PermissionSignals;
    focusedPermission:
      | {
          name: string;
        }
      | undefined;
    status: PermissionActionCardStatus;
    expirationAvailable: boolean;
    expiresIn: UserPermissionGrantExpiresIn;
    applyGrant: ApplyUserPermissionGrantFn;
    runCallback: (
      args: {
        readonly threadId: string;
        readonly agentId: string;
        readonly callbackPrompt: string;
      },
      signal: AbortSignal,
    ) => Promise<void>;
  },
  pageSignal: AbortSignal,
): () => void {
  return () => {
    const permissionName =
      params.focusedPermission?.name ?? params.block.permission;
    runPermissionAction({
      status: params.status,
      runUserGrant: () => {
        detach(
          (async () => {
            await params.applyGrant(
              {
                agentId: params.block.agentId,
                connectorSlug: params.block.connectorSlug,
                permission: permissionName,
                action: params.block.action,
                ...(params.expirationAvailable
                  ? { expiresIn: params.expiresIn }
                  : {}),
              },
              pageSignal,
            );
            if (params.block.callbackPrompt && params.block.threadId) {
              await params.runCallback(
                {
                  threadId: params.block.threadId,
                  agentId: params.block.agentId,
                  callbackPrompt: params.block.callbackPrompt,
                },
                pageSignal,
              );
            }
          })(),
          Reason.DomCallback,
        );
      },
    });
  };
}

function PermissionActionCardContent({
  signals,
  icon,
  connectorLabel,
  actionLabel,
  permissionName,
  status,
  expirationAvailable,
  expiresIn,
  onExpiresInChange,
  expiresAt,
  onClick,
}: {
  signals: PermissionSignals;
  icon: PlatformConnectorPermissionMetadata["icon"] | undefined;
  connectorLabel: string;
  actionLabel: string;
  permissionName: string;
  status: PermissionActionCardStatus;
  expirationAvailable: boolean;
  expiresIn: UserPermissionGrantExpiresIn;
  onExpiresInChange: (value: UserPermissionGrantExpiresIn) => void;
  expiresAt: string | null;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const remainingMs = expiresAtMs - now();
  const hourCount = Math.round(remainingMs / (60 * 60 * 1000));
  const dayCount = Math.round(remainingMs / (24 * 60 * 60 * 1000));
  const expiryText =
    !expirationAvailable || !Number.isFinite(expiresAtMs)
      ? null
      : remainingMs <= 0
        ? t(($) => {
            return $.chat.permissions.expired;
          })
        : hourCount > 24
          ? t(
              ($) => {
                return $.chat.permissions.expiresInDays;
              },
              { count: dayCount },
            )
          : hourCount <= 1
            ? null
            : t(
                ($) => {
                  return $.chat.permissions.expiresInHours;
                },
                {
                  count: hourCount,
                },
              );
  const showDurationSelect =
    expirationAvailable &&
    (status.kind === "ready" ||
      status.kind === "saving" ||
      status.kind === "save-error");
  return (
    <div
      data-testid="permission-action-card"
      className="okou-chat-card flex min-h-[88px] w-full flex-col gap-3 p-3 text-left sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
          <ConnectorIcon icon={icon} size={22} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[0.9375rem] font-medium text-foreground">
            {t(
              ($) => {
                return $.chat.permissions.connectorTitle;
              },
              {
                connectorName: connectorLabel,
              },
            )}
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
            {t(
              ($) => {
                return $.chat.permissions.actionDescription;
              },
              {
                action: actionLabel,
                permissionName,
              },
            )}
          </div>
          {status.kind !== "loading" && (
            <PermissionActionInlineStatus status={status} />
          )}
          {expiryText && (
            <div className="mt-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              {expiryText}
            </div>
          )}
        </div>
      </div>
      {permissionActionHasControls(status) && (
        <div
          data-testid="permission-action-card-controls"
          className="flex min-h-9 w-full shrink-0 flex-row items-center gap-2 sm:w-auto"
        >
          {status.kind === "loading" && (
            <PermissionActionInlineStatus status={status} />
          )}
          {showDurationSelect && (
            <PermissionGrantDurationSelect
              value={expiresIn}
              onValueChange={onExpiresInChange}
              disabled={status.kind === "saving"}
              ariaLabel={t(($) => {
                return $.chat.permissions.duration;
              })}
            />
          )}
          <PermissionActionTerminalStatus
            status={status}
            action={signals.action}
          />
          <PermissionActionButton status={status} onClick={onClick} />
        </div>
      )}
    </div>
  );
}

function PermissionActionCardForTarget({
  signals,
  hasTarget,
  targetLoadableState,
  userGrantsLoadable,
}: {
  signals: PermissionSignals;
  hasTarget: boolean;
  targetLoadableState: string;
  userGrantsLoadable: LoadableLike<readonly PermissionActionUserGrant[]>;
}) {
  const pageSignal = useGet(pageSignal$);
  const expirationAvailable = signals.action === "allow";
  const durationScope = `${signals.href}\u0000${signals.expiresIn ?? ""}`;
  const expiresInByScope = useGet(permissionGrantExpiresInByScope$);
  const setExpiresInForScope = useSet(setPermissionGrantExpiresIn$);
  const expiresIn =
    expiresInByScope[durationScope] ??
    signals.expiresIn ??
    DEFAULT_USER_PERMISSION_GRANT_EXPIRES_IN;
  const permissionMetadataLoadable = useLoadable(signals.metadata$);
  const [grantLoadable, applyGrant] = useLoadableSet(applyUserPermissionGrant$);
  const runCallback = useSet(runChatActionCallback$);
  const savedGrant =
    grantLoadable.state === "hasData" ? grantLoadable.data : null;
  const savedGrantActive = savedGrant
    ? isActiveUserPermissionGrant(savedGrant)
    : false;
  const existingGrant = permissionActionUserGrant(userGrantsLoadable, signals);
  const existingGrantActive = existingGrant
    ? isActiveUserPermissionGrant(existingGrant)
    : false;
  const actionState = createPermissionActionCardViewState({
    block: signals,
    hasAgent: hasTarget,
    agentLoadableState: targetLoadableState,
    permissionMetadataLoadable,
    userGrantsLoadable,
    grantLoadableState: grantLoadable.state,
    savedGrantActive,
  });
  const permissionMetadata =
    permissionMetadataLoadable.state === "hasData"
      ? permissionMetadataLoadable.data
      : null;
  const grantExpiresAt = permissionActionGrantExpiresAt({
    savedGrant,
    savedGrantActive,
    existingGrant,
    existingGrantActive,
    status: actionState.status,
  });

  return withChatScrollLayout(
    <PermissionActionCardContent
      signals={signals}
      icon={permissionMetadata?.icon}
      connectorLabel={permissionMetadata?.label ?? signals.connectorSlug}
      actionLabel={actionState.actionLabel}
      permissionName={permissionActionPermissionLabel(
        actionState.focusedPermission,
        signals.permission,
      )}
      status={actionState.status}
      expirationAvailable={expirationAvailable}
      expiresIn={expiresIn}
      onExpiresInChange={(value) => {
        setExpiresInForScope(durationScope, value);
      }}
      expiresAt={grantExpiresAt}
      onClick={createPermissionActionHandler(
        {
          block: signals,
          focusedPermission: actionState.focusedPermission,
          status: actionState.status,
          expirationAvailable,
          expiresIn,
          applyGrant,
          runCallback,
        },
        pageSignal,
      )}
    />,
  );
}

function PermissionActionCard({ signals }: { signals: PermissionSignals }) {
  const agentLoadable = useLastLoadable(signals.agent$);
  const userGrantsLoadable = useLoadable(signals.grants$);
  const agent = agentLoadable.state === "hasData" ? agentLoadable.data : null;
  return (
    <PermissionActionCardForTarget
      signals={signals}
      hasTarget={Boolean(agent)}
      targetLoadableState={agentLoadable.state}
      userGrantsLoadable={userGrantsLoadable}
    />
  );
}
