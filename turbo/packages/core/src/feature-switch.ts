/**
 * Feature switch system
 *
 * Provides centralized feature flag management with user-identity based overrides.
 * User IDs are stored as FNV-1a hashes to avoid exposing plain-text identifiers in source code.
 *
 * NOT AN AUTHORIZATION BOUNDARY. Most registered switches accept user overrides
 * through `POST /api/feature-switches`. For money-granting, credential, or
 * privilege-escalation endpoints, gate with a hard identity check (e.g.
 * `isStaffOrg()` from `./staff-org`) instead of this system.
 */

import { FeatureSwitchKey } from "./feature-switch-key";
import {
  STAFF_ORG_ID_FINGERPRINTS,
  STAFF_ORG_ID_HASHES,
  fnv1a,
} from "./identity-hash";
import { isStaffOrg } from "./staff-org";

export interface FeatureSwitch {
  readonly maintainer: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly enabledUserHashes?: readonly string[];
  readonly enabledEmailHashes?: readonly string[];
  readonly enabledOrgIdHashes?: readonly string[];
  /** Keep opt-in overrides within the configured rollout audience. */
  readonly restrictOverridesToAudience?: boolean;
  /** Allow staff to opt in without enabling the switch by default for staff. */
  readonly staffOptInOnly?: boolean;
}

export interface FeatureSwitchMetadata {
  readonly maintainer: string;
  readonly description: string;
  readonly rolloutStage: FeatureSwitchRolloutStage;
}

export type FeatureSwitchRolloutStage =
  "released" | "beta" | "alpha" | "internal";

export interface FeatureSwitchContext {
  readonly userId?: string;
  readonly email?: string;
  readonly orgId?: string;
  readonly overrides?: Partial<Record<FeatureSwitchKey, boolean>>;
}

/**
 * Registry of all feature switches
 */
const FEATURE_SWITCHES: Record<FeatureSwitchKey, FeatureSwitch> = {
  [FeatureSwitchKey.WorkflowListRedesign]: {
    maintainer: "ming@okou.ai",
    description:
      "Browse workflows with search, separate visibility and automation filters, and a flat list sorted by creation date.",
    enabled: false,
  },
  [FeatureSwitchKey.IosConnectorAppAuthorization]: {
    maintainer: "yuma@okou.ai",
    description:
      "Authorize TikTok, Dropbox and Spotify through their iOS apps with browser recovery.",
    enabled: false,
    staffOptInOnly: true,
  },
  [FeatureSwitchKey.ComposerVoiceMessages]: {
    maintainer: "ethan@okou.ai",
    description:
      "Use recordings as chat attachments instead of dictation for everyone in this workspace.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatShareRefresh]: {
    maintainer: "ming@okou.ai",
    description:
      "Share messages from a card in the composer's place: Select all, one selection count, unselected messages faded back, and a Copy link action once the link exists.",
    enabled: false,
  },
  [FeatureSwitchKey.OnboardingMultipleOutputs]: {
    maintainer: "scarlettx@okou.ai",
    description:
      "Honor multiple output formats selected by onboarding task links.",
    enabled: true,
  },
  [FeatureSwitchKey.ArtifactThreePointTiming]: {
    maintainer: "bingjie@okou.ai",
    description:
      "Record versioned research, generation, and authenticated completion observations in Axiom.",
    enabled: true,
  },
  [FeatureSwitchKey.PhoneUse]: {
    maintainer: "lancy@okou.ai",
    description: "Internal cloud-controlled iOS device automation.",
    enabled: false,
  },
  [FeatureSwitchKey.CustomConnectorCloudflareAccess]: {
    maintainer: "liangyou@okou.ai",
    description:
      "Use organization Cloudflare Access for custom HTTP API and MCP connectors.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.RemoteDevices]: {
    maintainer: "liangyou@okou.ai",
    description: "Manage remote channels and access at the device level.",
    enabled: false,
  },
  [FeatureSwitchKey.MemberConnectorAccountAccess]: {
    maintainer: "liangyou@okou.ai",
    description: "Apply connector account eligibility across a member's chats.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.EmailIntegration]: {
    maintainer: "yuma@okou.ai",
    description:
      "Email Okou and continue each email conversation in its own chat.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
    enabledEmailHashes: [
      fnv1a("yuma@vm0.ai"),
      fnv1a("qa-signup-20261112-21e53024@okou.io"),
    ],
  },
  [FeatureSwitchKey.PresentationOutputFormat]: {
    maintainer: "bingjie@okou.ai",
    description:
      "Choose HTML or PPTX for presentations and remember the preference on this device.",
    enabled: false,
    enabledUserHashes: ["032a75d8"], // Bingjie's account, including API contexts without email
    enabledEmailHashes: ["6490c77f"], // bingjie@okou.ai
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatThreadFork]: {
    maintainer: "ethan@okou.ai",
    description:
      "Start a new chat with a reference to a conversation from its menu.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
    restrictOverridesToAudience: true,
  },
  [FeatureSwitchKey.HideEmptyForYou]: {
    maintainer: "ethan@okou.ai",
    description: "Show For you in the chat list only when the feed has cards.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatListAllFilter]: {
    maintainer: "ethan@okou.ai",
    description:
      "Show unarchived chats by default and include archived Projects and chats in All.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
    restrictOverridesToAudience: true,
  },
  [FeatureSwitchKey.ProjectArchive]: {
    maintainer: "ethan@okou.ai",
    description: "Archive and restore Projects from their row menu.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ProjectTitleReveal]: {
    maintainer: "ming@okou.ai",
    description:
      "Show more of Project names with fading overflow and reveal them on hover or keyboard focus.",
    enabled: true,
  },
  [FeatureSwitchKey.OkouAnimatedAvatar]: {
    maintainer: "tongx@okou.ai",
    description:
      "Draw Okou's avatar with the animated design-system avatar everywhere the default artwork appears.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.TikTokOAuthConnector]: {
    maintainer: "yuma@okou.ai",
    description:
      "Connect a TikTok account with automatically refreshed read-only access.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
    restrictOverridesToAudience: true,
  },
  [FeatureSwitchKey.ComputerUseAppStateDirectTransfer]: {
    maintainer: "lancy@okou.ai",
    description:
      "Deliver the current Mac window state and PNG directly to the Run through its Runner.",
    enabled: false,
    staffOptInOnly: true,
  },
  [FeatureSwitchKey.DesktopShell]: {
    maintainer: "lancy@okou.ai",
    description:
      "Use interactive shells on an authorized computer with local opt-in.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ZipArtifactPreview]: {
    maintainer: "liangyou@okou.ai",
    description: "Browse and preview files inside ZIP artifacts up to 5 MiB.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ArtifactLibrary]: {
    maintainer: "bingjie@okou.ai",
    description:
      "Browse artifacts in a searchable list with type filters, creation-time sorting, and the existing sidebar previews.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.SlashActions]: {
    maintainer: "tongx@okou.ai",
    description:
      "Lead the composer's slash menu with chat actions, and open Workflows and action settings as second-level lists.",
    enabled: false,
  },
  [FeatureSwitchKey.FollowupPlaceholder]: {
    maintainer: "ethan@okou.ai",
    description:
      "Show the first follow-up in the empty composer and press Tab to accept it.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatLatestTurnScrollRoom]: {
    maintainer: "ethan@okou.ai",
    description:
      "Leave room below a short reply so the latest question can scroll to the top of the conversation.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatReplyNameLine]: {
    maintainer: "tongx@okou.ai",
    description:
      "Open each chat reply with the agent's avatar and name inside the reading column, and pick messages to share from a checkbox column beside them.",
    enabled: false,
  },
  [FeatureSwitchKey.CloudBrowserPanel]: {
    maintainer: "tongx@okou.ai",
    description:
      "Show who is in control with Take over and Hand back, use a floating loading status instead of the permanent footer, and refine the start button.",
    enabled: false,
  },
  [FeatureSwitchKey.ShareAudienceDescriptions]: {
    maintainer: "ming@okou.ai",
    description:
      "Describe each Who can access option in the share menu with one line, and anchor Copy link as a full-width footer under a divider.",
    enabled: true,
  },
  [FeatureSwitchKey.WorksChannelCards]: {
    maintainer: "ming@okou.ai",
    description:
      "Show Works channels in a compact grid with usage examples and icon actions for connecting and managing accounts.",
    enabled: false,
  },
  [FeatureSwitchKey.HostedSiteShareRows]: {
    maintainer: "ming@okou.ai",
    description:
      "Lay out the website Share menu's banner and Customize URL as menu rows under the access options, with the current address and a chevron on Customize URL and a full-width Copy link.",
    enabled: true,
  },
  [FeatureSwitchKey.ArtifactUserSharing]: {
    maintainer: "yuma@okou.ai",
    description:
      "Share artifacts with workspace members through the unified artifact access API.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.HostedSiteCustomDomains]: {
    maintainer: "yuma@okou.ai",
    description:
      "Connect verified custom domains from Customize URL with a subscription.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.FreePlanArtifactPaywall]: {
    maintainer: "ming@okou.ai",
    description:
      "Reserve artifact downloads, Customize URL, and hiding the website banner for paid plans; free-plan workspaces see an upgrade prompt instead.",
    enabled: true,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.SubscriptionLinkingEntry]: {
    maintainer: "tongx@okou.ai",
    description:
      "Expose personal subscription linking in the composer model slot and the account menu.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.PresentationConvert]: {
    maintainer: "bingjie@okou.ai",
    description:
      "Convert an HTML presentation into an editable pptx from the CLI.",
    enabled: false,
    enabledUserHashes: ["032a75d8"], // Bingjie's account, including API contexts without email
    enabledEmailHashes: ["6490c77f"], // bingjie@okou.ai
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.Dummy]: {
    maintainer: "ethan@okou.ai",
    description: "Test-only feature switch for flag system validation",
    enabled: true,
  },
  [FeatureSwitchKey.DocuSignConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the DocuSign e-signature connector",
    enabled: false,
  },
  [FeatureSwitchKey.AppStoreConnect]: {
    maintainer: "lancy@okou.ai",
    description:
      "Manage Apple app listings, TestFlight builds, reviews and releases.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.PayPalConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the PayPal payments connector",
    enabled: false,
  },
  [FeatureSwitchKey.RampConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Ramp spend management connector",
    enabled: false,
  },
  [FeatureSwitchKey.SpotifyConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Spotify connector integration",
    enabled: false,
  },
  [FeatureSwitchKey.OkouDebug]: {
    maintainer: "ethan@okou.ai",
    description:
      "Reveal activity debug surfaces, activity log navigation, appended system prompts, and Debug preferences",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.Banking]: {
    maintainer: "yuma@okou.ai",
    description:
      "Enable the managed banking gateway and banking:read OKOU_TOKEN capability for Finicity-backed accounts, balances, and transactions.",
    enabled: false,
  },
  [FeatureSwitchKey.Lab]: {
    maintainer: "ethan@okou.ai",
    description: "Show the Lab page for viewing feature rollout stages",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.TestOauthConnector]: {
    maintainer: "liangyou@okou.ai",
    description:
      "Enable the test-oauth connector, a synthetic OAuth 2.0 provider used only for automated tests. Off in prod.",
    enabled: false,
  },
  [FeatureSwitchKey.ZoomConnector]: {
    maintainer: "yuma@okou.ai",
    description:
      "Enable the Zoom connector (OAuth 2.0) for meetings, past participants, and cloud recordings access",
    enabled: false,
  },
  [FeatureSwitchKey.RealAgentInPreview]: {
    maintainer: "ethan@okou.ai",
    description:
      "Send preview chat runs through real agent CLIs instead of preview mock runners.",
    enabled: false,
  },
  [FeatureSwitchKey.CodexExecution]: {
    maintainer: "liangyou@okou.ai",
    description:
      "Test-only override to use Codex instead of Pi for supported ChatGPT subscription runs. Auto always stays on Pi.",
    enabled: false,
  },
  [FeatureSwitchKey.GeminiAntigravity]: {
    maintainer: "lancy@okou.ai",
    description:
      "Opt into Neon, Carbon, and Hydrogen with a personal Google AI subscription.",
    enabled: false,
    staffOptInOnly: true,
  },
  [FeatureSwitchKey.CodexSubscriptionUltrafast]: {
    maintainer: "ethan@okou.ai",
    description: "Offer Ultrafast on supported personal Codex routes.",
    enabled: false,
  },
  [FeatureSwitchKey.LarkIntegration]: {
    maintainer: "yuma@okou.ai",
    description: "Enable Lark bot setup, account connections, and messaging.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.WechatIntegration]: {
    maintainer: "yuma@okou.ai",
    description:
      "Connect WeChat by QR code and chat with Okou in direct messages.",
    enabled: false,
    enabledOrgIdHashes: [...STAFF_ORG_ID_HASHES, "3043664c"],
  },
  [FeatureSwitchKey.WhatsappIntegration]: {
    maintainer: "yuma@okou.ai",
    description:
      "Connect WhatsApp to Okou through the shared AgentPhone number.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.LarkOfficialBot]: {
    maintainer: "yuma@okou.ai",
    description: "Connect to the Okou Official Lark bot.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.FeishuIntegration]: {
    maintainer: "yuma@okou.ai",
    description:
      "Show the Feishu direct-message integration and Works page entry point.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.GoogleSlidesConversion]: {
    maintainer: "bingjie@okou.ai",
    description:
      "Sync presentation artifacts to Drive as native Google Slides decks instead of storing the uploaded file.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
    enabledUserHashes: ["032a75d8"], // Bingjie's account, including API contexts without email
    enabledEmailHashes: ["6490c77f"], // bingjie@okou.ai
  },
};

interface ResolvedHashes {
  readonly userHash?: string;
  readonly emailHash?: string;
  readonly orgIdHash?: string;
}

function evaluateSwitch(fs: FeatureSwitch, hashes: ResolvedHashes): boolean {
  if (fs.enabled) return true;
  if (hashes.userHash && fs.enabledUserHashes?.includes(hashes.userHash))
    return true;
  if (hashes.emailHash && fs.enabledEmailHashes?.includes(hashes.emailHash))
    return true;
  if (hashes.orgIdHash && fs.enabledOrgIdHashes?.includes(hashes.orgIdHash))
    return true;
  return false;
}

/** Digests for evaluating a switch's staff organization audience in PostgreSQL. */
export function getStaffOrgRolloutDigests(key: FeatureSwitchKey): string[] {
  const orgHashes = FEATURE_SWITCHES[key].enabledOrgIdHashes;
  return STAFF_ORG_ID_FINGERPRINTS.filter(({ hash }) => {
    return orgHashes?.includes(hash);
  }).map(({ sha256 }) => {
    return sha256;
  });
}

/** Whether this identity may opt into or manage a switch in Lab. */
export function isFeatureSwitchAvailable(
  key: FeatureSwitchKey,
  ctx: FeatureSwitchContext,
): boolean {
  const feature = FEATURE_SWITCHES[key];
  if (feature.staffOptInOnly) {
    return isStaffOrg(ctx.orgId);
  }
  return (
    !feature.restrictOverridesToAudience ||
    evaluateSwitch(feature, {
      userHash: ctx.userId ? fnv1a(ctx.userId) : undefined,
      emailHash: ctx.email ? fnv1a(ctx.email.toLowerCase()) : undefined,
      orgIdHash: ctx.orgId ? fnv1a(ctx.orgId) : undefined,
    })
  );
}

/**
 * Return defaults enabled by the supplied email identity alone.
 *
 * The API feature-switch response cannot evaluate email allowlists because its
 * auth context contains only user and organization IDs. Platform reapplies
 * these defaults after the server's effective map, before stored overrides.
 */
export function getEmailEnabledFeatureStates(
  email?: string,
): Partial<Record<FeatureSwitchKey, true>> {
  const result: Partial<Record<FeatureSwitchKey, true>> = {};
  if (!email) {
    return result;
  }

  const emailHash = fnv1a(email.toLowerCase());
  for (const key of Object.values(FeatureSwitchKey)) {
    if (FEATURE_SWITCHES[key].enabledEmailHashes?.includes(emailHash)) {
      result[key] = true;
    }
  }
  return result;
}

/**
 * Evaluate all feature switches at once for the given context.
 *
 * Computes identity hashes once and checks all switches synchronously.
 */
export function getAllFeatureStates(
  ctx?: FeatureSwitchContext,
): Record<FeatureSwitchKey, boolean> {
  const switches = Object.values(FEATURE_SWITCHES);
  const hashes: ResolvedHashes = {
    userHash:
      ctx?.userId &&
      switches.some((s) => {
        return s.enabledUserHashes?.length;
      })
        ? fnv1a(ctx.userId)
        : undefined,
    emailHash:
      ctx?.email &&
      switches.some((s) => {
        return s.enabledEmailHashes?.length;
      })
        ? fnv1a(ctx.email.toLowerCase())
        : undefined,
    orgIdHash:
      ctx?.orgId &&
      switches.some((s) => {
        return s.enabledOrgIdHashes?.length;
      })
        ? fnv1a(ctx.orgId)
        : undefined,
  };

  const result = {} as Record<FeatureSwitchKey, boolean>;
  for (const key of Object.values(FeatureSwitchKey)) {
    result[key] = evaluateSwitch(FEATURE_SWITCHES[key], hashes);
  }

  if (ctx?.overrides) {
    for (const [key, value] of Object.entries(ctx.overrides)) {
      if (key in FEATURE_SWITCHES && value !== undefined) {
        result[key as FeatureSwitchKey] =
          value && isFeatureSwitchAvailable(key as FeatureSwitchKey, ctx);
      }
    }
  }

  return result;
}

/**
 * Return the description for every feature switch.
 */
export function getFeatureSwitchDescriptions(): Record<
  FeatureSwitchKey,
  string | undefined
> {
  const result = {} as Record<FeatureSwitchKey, string | undefined>;
  for (const key of Object.values(FeatureSwitchKey)) {
    result[key] = FEATURE_SWITCHES[key].description;
  }
  return result;
}

function getFeatureSwitchRolloutStage(
  key: FeatureSwitchKey,
  featureSwitch: FeatureSwitch,
): FeatureSwitchRolloutStage {
  if (key.startsWith("_")) {
    return "internal";
  }
  if (featureSwitch.enabled) {
    return "released";
  }
  if (
    featureSwitch.enabledOrgIdHashes?.some((hash) => {
      return STAFF_ORG_ID_HASHES.includes(hash);
    })
  ) {
    return "beta";
  }
  return "alpha";
}

/**
 * Return display metadata for every feature switch.
 */
export function getFeatureSwitchMetadata(): Record<
  FeatureSwitchKey,
  FeatureSwitchMetadata
> {
  const result = {} as Record<FeatureSwitchKey, FeatureSwitchMetadata>;
  for (const key of Object.values(FeatureSwitchKey)) {
    const featureSwitch = FEATURE_SWITCHES[key];
    result[key] = {
      maintainer: featureSwitch.maintainer,
      description: featureSwitch.description,
      rolloutStage: getFeatureSwitchRolloutStage(key, featureSwitch),
    };
  }
  return result;
}

/** Keep overrides for currently registered feature switches. */
export function filterFeatureSwitchOverrides(
  switches: Record<string, boolean>,
): Record<string, boolean> {
  const filtered: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(switches)) {
    if (key in FEATURE_SWITCHES) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Check if a feature is enabled for the given context.
 *
 * `ctx` is required so callers must pass identity (userId/orgId/email) or an
 * explicit `{}`. A switch gated by `enabledUserHashes` / `enabledOrgIdHashes`
 * silently returns `false` when ctx omits identity, which has caused bugs.
 * Client-side callers should usually read the platform `featureSwitches$` signal
 * instead — it also merges DB overrides on top of identity context.
 */
export function isFeatureEnabled(
  key: FeatureSwitchKey,
  ctx: FeatureSwitchContext,
): boolean {
  if (!isFeatureSwitchAvailable(key, ctx)) {
    return false;
  }
  const override = ctx.overrides?.[key];
  if (override !== undefined) {
    return override;
  }

  const featureSwitch = FEATURE_SWITCHES[key];
  if (featureSwitch.enabled) {
    return true;
  }
  if (ctx.userId && featureSwitch.enabledUserHashes?.length) {
    if (featureSwitch.enabledUserHashes.includes(fnv1a(ctx.userId)))
      return true;
  }
  if (ctx.email && featureSwitch.enabledEmailHashes?.length) {
    if (
      featureSwitch.enabledEmailHashes.includes(fnv1a(ctx.email.toLowerCase()))
    )
      return true;
  }
  if (ctx.orgId && featureSwitch.enabledOrgIdHashes?.length) {
    if (featureSwitch.enabledOrgIdHashes.includes(fnv1a(ctx.orgId)))
      return true;
  }
  return false;
}
