import { useGet, useLastResolved } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { agents$ } from "../../signals/agent.ts";
import { currentChatAgentDisplayName$ } from "../../signals/agent-chat.ts";
import { resolveAvatarUrl, resolveAvatarSvgConfig } from "./avatar-utils.ts";
import { AvatarSvgPreview } from "./avatar-svg-preview.tsx";
import { assistantName$ } from "../../signals/branding.ts";

/**
 * Returns labels for the current agent-scoped chat thread list.
 * Used by both the sidebar thread list and the full chat-list page so the two
 * surfaces stay in sync without duplicating the logic.
 */
export function useChatThreadsTitleLabels() {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  const agentDisplayName = useLastResolved(currentChatAgentDisplayName$);
  const agentName = agentDisplayName ?? assistantName;
  return {
    titleLabel: t(
      ($) => {
        return $.chat.sidebar.chatsWith;
      },
      { agentName },
    ),
    newChatAriaLabel: t(
      ($) => {
        return $.chat.sidebar.newChatWith;
      },
      { agentName },
    ),
  };
}

interface AgentAvatarState {
  /** Resolved image URL, or null when SVG/loading. */
  src: string | null;
  /** Raw avatarUrl from the DB, used to detect SVG avatars. */
  rawAvatarUrl: string | null | undefined;
}

/**
 * Reactive hook that returns the agent avatar state from the DB.
 * Returns `{ src: null, rawAvatarUrl: null }` while the agent id is unknown
 * (still loading) or the agent has no avatar set.
 */
function useAgentAvatarState(id: string): AgentAvatarState {
  const resolved = useLastResolved(agents$);
  if (!id || resolved === undefined) {
    return { src: null, rawAvatarUrl: null };
  }
  const agent = resolved.find((a) => {
    return a.agentId === id;
  });
  const rawAvatarUrl = agent?.avatarUrl;
  const dbAvatar = resolveAvatarUrl(rawAvatarUrl);
  return { src: dbAvatar, rawAvatarUrl };
}

/**
 * Render an avatar from an avatarUrl string (preset, svg, or custom upload).
 * Does NOT look up the agent — use this when you already have the avatarUrl.
 *
 * Callers should pass shape and size but not a background fill: preset and
 * uploaded avatars are transparent, so a fill shows through as a gray disc
 * behind the face. WorkflowAgentAvatar is the one deliberate exception, where
 * the avatar shares a bordered chip style with its initials fallback.
 */
export function AvatarFromUrl({
  avatarUrl,
  alt,
  className,
  size,
  "data-testid": testId,
}: {
  avatarUrl: string | null | undefined;
  alt: string;
  className: string;
  size?: number;
  "data-testid"?: string;
}) {
  const svgConfig = resolveAvatarSvgConfig(avatarUrl);
  if (svgConfig) {
    return (
      <AvatarSvgPreview
        config={svgConfig}
        size={size}
        className={className}
        alt={alt}
        data-testid={testId}
      />
    );
  }
  const src = resolveAvatarUrl(avatarUrl);
  if (src) {
    return (
      <img src={src} alt={alt} className={className} data-testid={testId} />
    );
  }
  // Transparent placeholder, matching AgentAvatarImg: reserves the avatar's box
  // so layout doesn't shift while the agent (or its avatarUrl) is still loading.
  return <span className={className} aria-hidden="true" data-testid={testId} />;
}

/** Reactive avatar image that respects DB-persisted and user overrides. */
export function AgentAvatarImg({
  name,
  alt,
  className,
  size,
  preserveChinBaseline = false,
  "data-testid": testId,
}: {
  name: string;
  alt: string;
  className: string;
  size?: number;
  preserveChinBaseline?: boolean;
  "data-testid"?: string;
}) {
  const { src, rawAvatarUrl } = useAgentAvatarState(name);

  // SVG avatar (preset or custom svg:)
  const svgConfig = resolveAvatarSvgConfig(rawAvatarUrl);
  if (svgConfig) {
    return (
      <AvatarSvgPreview
        config={svgConfig}
        size={size}
        preserveChinBaseline={preserveChinBaseline}
        className={className}
        alt={alt}
        data-testid={testId}
      />
    );
  }

  // Custom uploaded image
  if (src) {
    return (
      <img src={src} alt={alt} className={className} data-testid={testId} />
    );
  }

  // Transparent placeholder: reserves the avatar's box so layout doesn't shift
  // while the agent (or its avatarUrl) is still loading, and avoids flashing a
  // default preset that doesn't match the agent's real avatar.
  return <span className={className} aria-hidden="true" data-testid={testId} />;
}
