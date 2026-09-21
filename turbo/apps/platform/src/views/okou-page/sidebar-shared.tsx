import { useGet, useLastResolved } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { DEFAULT_AGENT_AVATAR_URL } from "@okouai/core/agent-avatar";
import {
  agentAvatarTexture,
  avatarTextureUrl,
  defaultAgentAvatarTextures,
} from "@okouai/core/agent-avatar-texture";
import { cn } from "@okouai/ui/lib/utils";
import { agents$ } from "../../signals/agent.ts";
import { currentChatAgentDisplayName$ } from "../../signals/agent-chat.ts";
import { resolveAvatarUrl, resolveAvatarSvgConfig } from "./avatar-utils.ts";
import { AvatarSvgPreview, AvatarTextureLayer } from "./avatar-svg-preview.tsx";
import { isLegacyAvatarSvgConfig } from "./avatar-svg-utils.ts";
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

/**
 * The brand texture for one agent, or null when it cannot have one.
 *
 * A texture is chosen to clear whatever the avatar itself is painted in, so it
 * needs to know those colours. Composer avatars carry them in their URL, and
 * the organization default agent is a known file whose palette is recorded in
 * core. An uploaded image and the legacy `svg:` configurations are neither, so
 * they get none. Pass a null id to opt out entirely — the hook still runs, so
 * callers stay unconditional.
 *
 * Exported because the frame around the avatar changes with the answer: with a
 * texture the frame's own hairline is redundant, and without one it is still
 * the only edge the artwork has.
 */
export function useAgentAvatarTexture(id: string | null): string | null {
  const { rawAvatarUrl } = useAgentAvatarState(id ?? "");
  if (id === null) {
    return null;
  }
  // The organization default agent is one drawn file rather than a composer
  // configuration, and it is the avatar most people see: every workspace's
  // chat home opens on it. It gets the one tile that clears the five brand
  // colours it is painted in, by the same rule as everyone else.
  if (rawAvatarUrl === DEFAULT_AGENT_AVATAR_URL) {
    const texture = defaultAgentAvatarTextures()[0];
    return texture ? avatarTextureUrl(texture) : null;
  }
  const svgConfig = resolveAvatarSvgConfig(rawAvatarUrl);
  if (!svgConfig || isLegacyAvatarSvgConfig(svgConfig)) {
    return null;
  }
  const texture = agentAvatarTexture(id, svgConfig);
  return texture ? avatarTextureUrl(texture) : null;
}

/** Reactive avatar image that respects DB-persisted and user overrides. */
export function AgentAvatarImg({
  name,
  alt,
  className,
  size,
  preserveChinBaseline = false,
  textureUrl,
  "data-testid": testId,
}: {
  name: string;
  alt: string;
  className: string;
  size?: number;
  preserveChinBaseline?: boolean;
  /**
   * Brand texture to draw behind the artwork, from `useAgentAvatarTexture`.
   * Only the chat home greeting passes one; it is the single surface that
   * shows one agent large enough for a brush mark to read as a brush mark.
   */
  textureUrl?: string;
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
        textureUrl={textureUrl}
        className={className}
        alt={alt}
        data-testid={testId}
      />
    );
  }

  // A drawn file: an uploaded image, or the organization default agent's own
  // SVG. Both are transparent, so a texture behind them shows through.
  if (src) {
    const image = (
      <img src={src} alt={alt} className={className} data-testid={testId} />
    );
    if (!textureUrl) {
      return image;
    }
    return (
      <span className={cn("relative block overflow-hidden", className)}>
        <AvatarTextureLayer url={textureUrl} />
        <img
          src={src}
          alt={alt}
          className="absolute inset-0 h-full w-full object-cover object-top"
          data-testid={testId}
        />
      </span>
    );
  }

  // Transparent placeholder: reserves the avatar's box so layout doesn't shift
  // while the agent (or its avatarUrl) is still loading, and avoids flashing a
  // default preset that doesn't match the agent's real avatar.
  return <span className={className} aria-hidden="true" data-testid={testId} />;
}
