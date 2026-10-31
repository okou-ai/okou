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
import { STAFF_ORG_ID_HASHES, fnv1a } from "./identity-hash";

export interface FeatureSwitch {
  readonly maintainer: string;
  readonly description?: string;
  readonly displayName?: string;
  readonly enabled: boolean;
  readonly enabledUserHashes?: readonly string[];
  readonly enabledEmailHashes?: readonly string[];
  readonly enabledOrgIdHashes?: readonly string[];
  /** Keep opt-in overrides within the configured rollout audience. */
  readonly restrictOverridesToAudience?: boolean;
}

export interface FeatureSwitchMetadata {
  readonly maintainer: string;
  readonly description?: string;
  readonly displayName?: string;
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
  [FeatureSwitchKey.LandingFileHandoff]: {
    maintainer: "ming@okou.ai",
    displayName: "Landing page files",
    description:
      "Carry browser-local files from Marketing through sign-in into a task.",
    enabled: true,
  },
  [FeatureSwitchKey.FirstTaskUpgrade]: {
    maintainer: "ming@okou.ai",
    displayName: "First task upgrade",
    description: "Show the Pro offer after a user's first completed chat task.",
    enabled: true,
  },
  [FeatureSwitchKey.ChatThinkingBrandMotion]: {
    maintainer: "ming@okou.ai",
    displayName: "Chat thinking brand motion",
    description:
      "Use a textured, breathing brand mark with subtle scaling, sheen, and cycling brand colors in chat thinking states.",
    enabled: false,
  },
  [FeatureSwitchKey.HalloweenQuiz]: {
    maintainer: "ming@okou.ai",
    displayName: "Halloween quiz",
    description:
      "Open the 2026 Halloween quiz from the animated chat home dialog and associate results with your account.",
    enabled: true,
  },
  [FeatureSwitchKey.FeatureGuides]: {
    maintainer: "yuma@okou.ai",
    displayName: "Feature guides",
    description: "Show published product updates once per user and edition.",
    enabled: false,
  },
  [FeatureSwitchKey.OnboardingSourceOutcomes]: {
    maintainer: "ming@okou.ai",
    displayName: "Onboarding source outcomes",
    description:
      "Show industry-specific examples of work prepared from connected tools.",
    enabled: true,
  },
  [FeatureSwitchKey.TeamsWorkspaceIdentity]: {
    maintainer: "yuma@okou.ai",
    displayName: "Teams workspace identity",
    description:
      "Connect your Microsoft Teams identity independently of bot installation and use it in shared conversations.",
    enabled: false,
  },
  [FeatureSwitchKey.BatchConnectorPermissions]: {
    maintainer: "ethan@okou.ai",
    displayName: "Batch connector permissions",
    description: "Approve up to 20 connector permissions together.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  // Visibility checks remain enforced independently of this management gate.
  [FeatureSwitchKey.SharedThreadVisibility]: {
    maintainer: "yuma@okou.ai",
    displayName: "Conversation share visibility",
    description: "Choose who can view a shared conversation.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.DesktopShell]: {
    maintainer: "lancy@okou.ai",
    displayName: "Desktop Shell",
    description:
      "Use interactive shells on an authorized computer with local opt-in.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.RemoteControlGuidedSetup]: {
    maintainer: "bingjie@okou.ai",
    displayName: "Remote control guided setup",
    description:
      "Set up and manage remote connections and private networks step by step.",
    enabled: true,
  },
  [FeatureSwitchKey.ArtifactSidebarPreview]: {
    maintainer: "ethan@okou.ai",
    displayName: "Artifact sidebar preview",
    description:
      "Open chat artifacts and artifacts-page previews directly in a sidebar instead of a lightbox.",
    enabled: false,
  },
  [FeatureSwitchKey.ArtifactDeletion]: {
    maintainer: "yuma@okou.ai",
    displayName: "Artifact deletion",
    description: "Delete owned artifacts and withdraw their Okou links.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ArtifactQuickActions]: {
    maintainer: "bingjie@okou.ai",
    displayName: "Artifact quick actions",
    description:
      "Open Share and Download on hover and copy links after saving sharing changes.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.SlashActions]: {
    maintainer: "tongx@okou.ai",
    displayName: "Slash actions",
    description:
      "Lead the composer's slash menu with chat actions, and open Workflows and Templates as second-level lists.",
    enabled: false,
  },
  [FeatureSwitchKey.ChatReplyNameLine]: {
    maintainer: "tongx@okou.ai",
    displayName: "Agent name on replies",
    description:
      "Open each chat reply with the agent's avatar and name inside the reading column, and pick messages to share from a checkbox column beside them.",
    enabled: false,
  },
  [FeatureSwitchKey.UnifiedChatWorkspace]: {
    maintainer: "tongx@okou.ai",
    displayName: "Unified chat workspace",
    description:
      "Hold the chat list, the chat and its side panel in one sheet, with resizable dividers that remember their widths.",
    enabled: true,
  },
  [FeatureSwitchKey.CloudBrowserPanel]: {
    maintainer: "tongx@okou.ai",
    displayName: "Cloud browser panel",
    description:
      "Theme the cloud browser with app tokens, put its actions in the tab row, and show who is in control with Take over and Hand back.",
    enabled: false,
  },
  [FeatureSwitchKey.ChatThreadTimeline]: {
    maintainer: "yuma@okou.ai",
    displayName: "Chat timeline",
    description:
      "Separate chat history by day, with Today shown only alongside Yesterday.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.SubscriptionLinkingEntry]: {
    maintainer: "tongx@okou.ai",
    description:
      "Expose personal subscription linking in the composer model slot and the account menu.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.AgentSuggestion]: {
    maintainer: "lancy@okou.ai",
    displayName: "Suggestions",
    description: "Discover and curate useful next-step suggestions.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ProactiveAgent]: {
    maintainer: "lancy@okou.ai",
    displayName: "Proactive",
    description:
      "Review activity, learn, plan next steps and advance entrusted Tasks.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.PresentationConvert]: {
    maintainer: "bingjie@okou.ai",
    description:
      "Convert an HTML presentation into an editable pptx from the CLI.",
    enabled: false,
    // Limit the rollout to the maintainer across workspaces while conversion
    // fidelity is being evaluated.
    enabledUserHashes: ["032a75d8"], // Bingjie's account, including API contexts without email
    enabledEmailHashes: ["6490c77f"], // bingjie@okou.ai
  },
  [FeatureSwitchKey.MarkdownTableExport]: {
    maintainer: "bingjie@okou.ai",
    displayName: "Markdown table export",
    description:
      "Export tables to Excel or save them to Google Drive and Google Sheets.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatMessagePdf]: {
    maintainer: "ethan@okou.ai",
    displayName: "Message PDF export",
    description:
      "Generate a PDF of an assistant response, then download it with rendered diagrams, formulas, images, and clickable links.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatThreadInlineRename]: {
    maintainer: "tongx@okou.ai",
    displayName: "Inline chat rename",
    description: "Double-click a chat in the sidebar to rename it in place.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatHomeCompliance]: {
    maintainer: "tongx@okou.ai",
    displayName: "Chat home compliance",
    description:
      "Show the compliance status badges at the bottom of the chat home.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.BrowserNativeInput]: {
    maintainer: "liangyou@okou.ai",
    description:
      "Create native web forms that apply user-provided values to exact managed Browser controls",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.BrowserSharedOwner]: {
    maintainer: "liangyou@okou.ai",
    displayName: "Shared Browser",
    description:
      "Share website logins across chats with a separate window for each chat",
    enabled: false,
  },
  [FeatureSwitchKey.Dummy]: {
    maintainer: "ethan@okou.ai",
    description: "Test-only feature switch for flag system validation",
    enabled: true,
  },
  [FeatureSwitchKey.AhrefsConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Ahrefs SEO connector",
    enabled: false,
  },
  [FeatureSwitchKey.BillConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the BILL Spend & Expense connector",
    enabled: false,
  },
  [FeatureSwitchKey.BentomlConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the BentoML model serving connector",
    enabled: false,
  },
  [FeatureSwitchKey.CanvaConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Canva design connector",
    enabled: false,
  },
  [FeatureSwitchKey.DatadogConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Datadog observability connector",
    enabled: false,
  },
  [FeatureSwitchKey.DeelConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Deel HR connector",
    enabled: false,
  },
  [FeatureSwitchKey.DocuSignConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the DocuSign e-signature connector",
    enabled: false,
  },
  [FeatureSwitchKey.ExpensifyConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Expensify accounting connector",
    enabled: false,
  },
  [FeatureSwitchKey.MercuryConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Mercury banking connector",
    enabled: false,
  },
  [FeatureSwitchKey.NeonConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Neon serverless Postgres connector",
    enabled: false,
  },
  [FeatureSwitchKey.NetSuiteConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Oracle NetSuite ERP connector",
    enabled: false,
  },
  [FeatureSwitchKey.GarminConnectConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Garmin Connect wellness connector",
    enabled: false,
  },
  [FeatureSwitchKey.RedditConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Reddit connector integration",
    enabled: false,
  },
  [FeatureSwitchKey.SupabaseConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Supabase database connector integration",
    enabled: false,
  },
  [FeatureSwitchKey.CloseConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Close CRM connector",
    enabled: false,
  },
  [FeatureSwitchKey.WebflowConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Webflow site management connector",
    enabled: false,
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
  [FeatureSwitchKey.ResendConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Resend email service connector",
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
  [FeatureSwitchKey.LinkWalletApprovalContinuation]: {
    maintainer: "yuma@okou.ai",
    description:
      "Continue the originating web chat after a Link purchase approval using bounded Cloudflare Workflows polling.",
    enabled: false,
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
  [FeatureSwitchKey.FreshdeskConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Freshdesk helpdesk connector",
    enabled: false,
  },
  [FeatureSwitchKey.StabilityAiConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Stability AI image generation connector",
    enabled: false,
  },
  [FeatureSwitchKey.ZoomConnector]: {
    maintainer: "yuma@okou.ai",
    description:
      "Enable the Zoom connector (OAuth 2.0) for meetings, past participants, and cloud recordings access",
    enabled: false,
  },
  [FeatureSwitchKey.WorkdayConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Workday HCM and finance connector",
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
    displayName: "Codex execution (test only)",
    description:
      "Test-only override to use Codex instead of Pi for supported ChatGPT subscription runs. Auto always stays on Pi.",
    enabled: false,
  },
  [FeatureSwitchKey.ZapierConnector]: {
    maintainer: "yuma@okou.ai",
    description:
      "Enable the Zapier connector. When disabled, Zapier is hidden from the connectors list and cannot be connected.",
    enabled: false,
  },
  [FeatureSwitchKey.SidebarSubscriptionUsage]: {
    maintainer: "ethan@okou.ai",
    description:
      "Show personal subscription usage in the account menu and on Me, and provider credit balances on connected accounts.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.PwaNavigation]: {
    maintainer: "ethan@okou.ai",
    description:
      "Use bottom navigation, an agent chat list, and Me at mobile viewport widths in any browser.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
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
  [FeatureSwitchKey.WhatsappFileUpload]: {
    maintainer: "yuma@okou.ai",
    description:
      "Send private uploaded files to independently verified WhatsApp accounts. Enable after the matching Runner CLI is deployed.",
    enabled: false,
  },
  [FeatureSwitchKey.WhatsappIntegration]: {
    maintainer: "yuma@okou.ai",
    description:
      "Connect WhatsApp to Okou through the shared AgentPhone number.",
    enabled: false,
  },
  [FeatureSwitchKey.FeishuIntegration]: {
    maintainer: "yuma@okou.ai",
    description:
      "Show the Feishu direct-message integration and Works page entry point.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.AutoContinueBusyChats]: {
    maintainer: "bingjie@okou.ai",
    displayName: "Auto-continue busy chats",
    description:
      "Continue chats interrupted by a busy model after 1, 3, and 5 minutes, up to three times. Turning this off cancels waiting retries.",
    enabled: false,
    enabledUserHashes: ["032a75d8"],
  },
  [FeatureSwitchKey.ChatThreadArchiving]: {
    maintainer: "ethan@okou.ai",
    description:
      "Let users archive chats and hide archived chats from the sidebar unless they are unread or explicitly shown.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatThreadMuting]: {
    maintainer: "ethan@okou.ai",
    description:
      "Mute chats to suppress unread indicators, push notifications and automatic unarchiving.",
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

/** Whether this identity may opt into or manage a switch in Lab. */
export function isFeatureSwitchAvailable(
  key: FeatureSwitchKey,
  ctx: FeatureSwitchContext,
): boolean {
  const feature = FEATURE_SWITCHES[key];
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
      ...(featureSwitch.displayName === undefined
        ? {}
        : { displayName: featureSwitch.displayName }),
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
 * Client-side callers should usually read the platform `featureSwitch$` signal
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
