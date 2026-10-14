import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { ArrowUpRight } from "lucide-react";
import { BrandSlack, cn } from "@okouai/ui";
import type { UserMessageRenderPart } from "../../signals/chat-page/chat-event.ts";
import { DiscordMark } from "./components/discord-mark.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";

const annotationIconImgs = {
  feishu: settingsIconAssetUrl("lark"),
  lark: settingsIconAssetUrl("lark"),
  teams: settingsIconAssetUrl("teams"),
  telegram: settingsIconAssetUrl("telegram"),
  github: settingsIconAssetUrl("github"),
  agentphone: settingsIconAssetUrl("imessage"),
} as const;

// Discord permalinks always point at discord.com; any other destination is
// shown as an unlinked source instead of an off-site link.
const DISCORD_MESSAGE_URL =
  /^https:\/\/discord\.com\/channels\/(?:\d+|@me)\/\d+\/\d+$/u;

function sourceMessageHref(
  part: Extract<
    UserMessageRenderPart,
    { type: "source"; kind: "external" }
  >["part"],
): string | undefined {
  if (part.kind === "discord" && !DISCORD_MESSAGE_URL.test(part.href ?? "")) {
    return undefined;
  }
  return part.href;
}

function sourceMessageLinkText(
  t: TFunction<"common">,
  part: Extract<
    UserMessageRenderPart,
    { type: "source"; kind: "external" }
  >["part"],
) {
  const opensChat =
    part.kind === "feishu" ||
    part.kind === "lark" ||
    (part.kind === "telegram" &&
      /^https:\/\/t\.me\/[a-z\d_]+$/iu.test(part.href ?? "")) ||
    (part.kind === "teams" &&
      part.href?.startsWith("https://teams.microsoft.com/l/chat/") === true);
  const openLabel =
    part.kind === "agentphone"
      ? t(($) => {
          return $.chat.origins.openMessages;
        })
      : opensChat
        ? t(($) => {
            return $.chat.origins.openChat;
          })
        : t(($) => {
            return $.chat.origins.openMessage;
          });
  return { opensChat, openLabel };
}

function sourceMessageLabel(
  t: TFunction<"common">,
  kind: Extract<
    UserMessageRenderPart,
    { type: "source"; kind: "external" }
  >["part"]["kind"],
): string {
  switch (kind) {
    case "discord": {
      return t(($) => {
        return $.chat.origins.discord;
      });
    }
    case "slack": {
      return t(($) => {
        return $.chat.origins.slack;
      });
    }
    case "feishu": {
      return t(($) => {
        return $.chat.origins.feishu;
      });
    }
    case "lark": {
      return t(($) => {
        return $.chat.origins.lark;
      });
    }
    case "teams": {
      return t(($) => {
        return $.chat.origins.teams;
      });
    }
    case "telegram": {
      return t(($) => {
        return $.chat.origins.telegram;
      });
    }
    case "github": {
      return t(($) => {
        return $.chat.origins.github;
      });
    }
    case "agentphone": {
      return t(($) => {
        return $.chat.origins.agentphone;
      });
    }
  }
}

export function ExternalSourceMessageAnnotation({
  part,
  className,
  compact = false,
}: {
  readonly part: Extract<
    UserMessageRenderPart,
    { type: "source"; kind: "external" }
  >["part"];
  readonly className: string;
  readonly compact?: boolean;
}) {
  const { t } = useTranslation();
  // Historical messages used "feishu" for both platforms; their link can
  // identify Lark. New messages already carry the canonical source kind.
  const sourceKind =
    part.kind === "feishu" &&
    part.href?.startsWith("https://applink.larksuite.com/") === true
      ? "lark"
      : part.kind;
  const sourceLabel = sourceMessageLabel(t, sourceKind);
  const href = sourceMessageHref(part);
  const { opensChat, openLabel } = sourceMessageLinkText(t, part);
  const ariaLabel =
    opensChat && sourceKind !== "feishu" && sourceKind !== "lark"
      ? t(
          ($) => {
            return $.chat.origins.openChatIn;
          },
          { integration: sourceLabel },
        )
      : sourceKind === "slack"
        ? t(($) => {
            return $.chat.origins.openSlackMessage;
          })
        : sourceKind === "discord"
          ? t(($) => {
              return $.chat.origins.openDiscordMessage;
            })
          : sourceKind === "feishu" || sourceKind === "lark"
            ? t(($) => {
                return $.chat.origins[
                  sourceKind === "lark" ? "openLarkChat" : "openFeishuChat"
                ];
              })
            : sourceKind === "teams"
              ? t(($) => {
                  return $.chat.origins.openTeamsMessage;
                })
              : sourceKind === "telegram"
                ? t(($) => {
                    return $.chat.origins.openTelegramMessage;
                  })
                : sourceKind === "github"
                  ? t(($) => {
                      return $.chat.origins.openGithubMessage;
                    })
                  : openLabel;
  const content = (
    <>
      {sourceKind === "slack" ? (
        <BrandSlack size={15} className="shrink-0" />
      ) : sourceKind === "discord" ? (
        <DiscordMark size={15} />
      ) : (
        <img
          src={annotationIconImgs[sourceKind]}
          alt=""
          className="size-[15px] shrink-0 object-contain"
        />
      )}
      <span
        className={cn("min-w-0 truncate", {
          "flex-1": compact,
          "shrink-0": !compact,
        })}
      >
        {sourceLabel}
      </span>
      {href ? (
        <>
          {!compact && (
            <>
              <span className="shrink-0">·</span>
              <span className="min-w-0 truncate">{openLabel}</span>
            </>
          )}
          <ArrowUpRight size={12} className="shrink-0" />
        </>
      ) : null}
    </>
  );
  if (!href) {
    return <div className={className}>{content}</div>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={ariaLabel}
      className={`${className} transition-colors hover:bg-state-hover hover:text-foreground`}
    >
      {content}
    </a>
  );
}
