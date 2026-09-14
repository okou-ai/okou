/**
 * Feature switch system
 *
 * Provides centralized feature flag management with user-identity based overrides.
 * User IDs are stored as FNV-1a hashes to avoid exposing plain-text identifiers in source code.
 *
 * NOT AN AUTHORIZATION BOUNDARY. Every registered switch accepts user overrides
 * through `POST /api/feature-switches`. For money-granting, credential, or
 * privilege-escalation endpoints, gate with a hard identity check (e.g.
 * `isStaffOrg()` from `./staff-org`) instead of this system.
 */

import { FeatureSwitchKey } from "./feature-switch-key";
import { STAFF_ORG_ID_HASHES, fnv1a } from "./identity-hash";

export interface FeatureSwitch {
  readonly maintainer: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly enabledUserHashes?: readonly string[];
  readonly enabledEmailHashes?: readonly string[];
  readonly enabledOrgIdHashes?: readonly string[];
}

export interface FeatureSwitchMetadata {
  readonly maintainer: string;
  readonly description?: string;
  readonly rolloutStage: FeatureSwitchRolloutStage;
}

export type FeatureSwitchRolloutStage =
  | "released"
  | "beta"
  | "alpha"
  | "internal";

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
  [FeatureSwitchKey.SessionOutputStreaming]: {
    maintainer: "ethan@okou.ai",
    description:
      "Subscribe to transient session text output while a run is active",
    enabled: false,
  },
  [FeatureSwitchKey.SocialStatus]: {
    maintainer: "liangyou@okou.ai",
    description: "On-demand public Social service health",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.WelcomeThread]: {
    maintainer: "lancy@okou.ai",
    description: "Manually create a welcome conversation with fixed examples",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ThreadActivitySummary]: {
    maintainer: "lancy@okou.ai",
    description:
      "Generate short public activity summaries for active thread subscriptions.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ComposerTaskChips]: {
    maintainer: "bingjie@okou.ai",
    description: "Lightweight chat task chips and contextual starting ideas",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ComposerCreateCommands]: {
    maintainer: "bingjie@okou.ai",
    description: "Create commands and mode-specific composer controls",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
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
  [FeatureSwitchKey.CopperConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Copper CRM connector",
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
  [FeatureSwitchKey.FigmaConnector]: {
    maintainer: "yuma@okou.ai",
    description: "Enable the Figma design connector",
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
  [FeatureSwitchKey.StripeMarketplaceOAuthConnector]: {
    maintainer: "yuma@okou.ai",
    description:
      "Show Stripe Marketplace OAuth as a sign-in option for the Stripe connector.",
    enabled: false,
  },
  [FeatureSwitchKey.OkouDebug]: {
    maintainer: "ethan@okou.ai",
    description:
      "Reveal activity debug surfaces, activity log navigation, appended system prompts, realtime connection diagnostics, and Debug preferences",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.Banking]: {
    maintainer: "linghan@okou.ai",
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
  [FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations]: {
    maintainer: "lancy@okou.ai",
    description:
      "Enable Stripe invoice-paid workflow automations with immutable Live-mode OAuth bindings.",
    enabled: false,
  },
  [FeatureSwitchKey.OfficialWorkflows]: {
    maintainer: "lancy@okou.ai",
    description:
      "Enable Official Workflow catalog discovery and new installations.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.MorningBrief]: {
    maintainer: "lancy@okou.ai",
    description:
      "Enable Morning Brief and email subscription management in Preferences.",
    enabled: true,
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

  [FeatureSwitchKey.CodexFastMode]: {
    maintainer: "lancy@okou.ai",
    description: "Enable Codex fast mode for GPT 5.6 runs.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.RefactorModelSelect]: {
    maintainer: "bingjie@okou.ai",
    description:
      "Use the compact chat, image, and video model picker with Fast mode and chat reasoning effort controls.",
    enabled: false,
    enabledUserHashes: ["032a75d8"], // Bingjie's account, including API contexts without email
    enabledEmailHashes: ["6490c77f"], // bingjie@okou.ai
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ModelPickerFlyout]: {
    maintainer: "tongx@okou.ai",
    description:
      "Pick a model from a detached flyout: model types on the left, that type's models in a panel beside it.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatPreference]: {
    maintainer: "lancy@okou.ai",
    description:
      "Enable dedicated Chat settings and explicit new-chat default actions.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.RealAgentInPreview]: {
    maintainer: "ethan@okou.ai",
    description:
      "Send preview chat runs through real agent CLIs instead of preview mock runners.",
    enabled: false,
  },
  [FeatureSwitchKey.PiLoop]: {
    maintainer: "lancy@okou.ai",
    description:
      "Run owned chat threads with the official Pi runtime, native session persistence, and shared memory learning across interactive and automation turns.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.PiMemory]: {
    maintainer: "lancy@okou.ai",
    description:
      "Extract, consolidate, and recall memory for Pi threads. Off for everyone, including the staff org; enabled one user at a time through explicit overrides.",
    enabled: false,
  },
  [FeatureSwitchKey.OpenRouterUsRouting]: {
    maintainer: "liangyou@okou.ai",
    description:
      "Use US routing for supported models with platform-owned OpenRouter keys.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.LangfuseTrace]: {
    maintainer: "ethan@okou.ai",
    description:
      "Trace explicitly opted-in Pi runs across the API-first and Sandbox ownership boundary in Langfuse.",
    enabled: false,
  },
  [FeatureSwitchKey.IntroVideo]: {
    maintainer: "bingjie@okou.ai",
    description:
      "Enable intro videos with style, avatar, and voice selection in the template picker.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.AvatarNeckSweater]: {
    maintainer: "ming@okou.ai",
    description:
      "Give composer avatars a shared neck and sweater, scaling each head so every chin meets the same collar.",
    enabled: true,
  },
  [FeatureSwitchKey.AvatarFraming]: {
    maintainer: "tongx@okou.ai",
    description:
      "Center every avatar's visible artwork in its box and move it halfway to a shared fill, so hair volume stops changing how large an avatar looks.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatTranslation]: {
    maintainer: "yuma@okou.ai",
    description:
      "Translate selected assistant text into a remembered target language.",
    enabled: false,
  },
  [FeatureSwitchKey.ZapierConnector]: {
    maintainer: "yuma@okou.ai",
    description:
      "Enable the Zapier connector. When disabled, Zapier is hidden from the connectors list and cannot be connected.",
    enabled: false,
  },
  [FeatureSwitchKey.ComputerUseDesktopPlugins]: {
    maintainer: "lancy@okou.ai",
    description:
      "Enable Okou Desktop Computer Use plugins for local resources, starting with the bundled filesystem plugin gateway.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ReferenceImages]: {
    maintainer: "bingjie@okou.ai",
    description:
      "Enable reusable private and organization-visible image references.",
    enabled: false,
  },
  // Every artifact privacy slice in #32492 uses this same rollout switch.
  [FeatureSwitchKey.PrivateArtifacts]: {
    maintainer: "yuma@okou.ai",
    description:
      "Use private storage and authenticated previews for CLI artifact uploads and managed generation.",
    enabled: false,
  },
  [FeatureSwitchKey.ArtifactViewer]: {
    maintainer: "yuma@okou.ai",
    description:
      "Open artifact links in the Okou viewer with preview, download, and copy-link actions.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ProgressiveArtifactPreview]: {
    maintainer: "bingjie@okou.ai",
    description:
      "Publish coherent website and HTML presentation previews while the agent continues improving them.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ComposerImageAnnotation]: {
    maintainer: "tongx@okou.ai",
    description:
      "Let an attached image be marked up in the composer lightbox — boxes, arrows, freehand, text, highlight and redaction, each able to carry a note — and send a rendered copy carrying the editable marks.",
    enabled: false,
  },
  [FeatureSwitchKey.GradientColorThemes]: {
    maintainer: "ming@okou.ai",
    description:
      "Apply a palette-derived tint across interface surfaces, borders, states, and workspace ambience.",
    enabled: false,
  },
  [FeatureSwitchKey.SidebarSubscriptionUsage]: {
    maintainer: "ethan@okou.ai",
    description:
      "Show Codex and Claude Code personal subscription usage in the sidebar footer.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.PersonalSubscriptionPriority]: {
    maintainer: "lancy@okou.ai",
    description:
      "Preserve personal subscription identities for admitted runs and gate the personal subscription priority rollout.",
    enabled: false,
  },
  [FeatureSwitchKey.PersonalModelProviderAccounts]: {
    maintainer: "ethan@okou.ai",
    description:
      "Allow personal Codex and Claude Code subscriptions to store and manually switch between multiple accounts.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.LarkIntegration]: {
    maintainer: "linghan@okou.ai",
    description: "Enable Lark bot setup, account connections, and messaging.",
    enabled: false,
  },
  [FeatureSwitchKey.FeishuIntegration]: {
    maintainer: "linghan@okou.ai",
    description:
      "Show the Feishu direct-message integration and Works page entry point.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.CustomConnectorMcp]: {
    maintainer: "liangyou@okou.ai",
    description:
      "Enable remote Streamable HTTP MCP definitions for organization Custom Connectors.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.SshAccess]: {
    maintainer: "liangyou@okou.ai",
    description: "Enable standalone Runner-mediated SSH configuration",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ConnectorDirectory]: {
    maintainer: "tongx@okou.ai",
    description:
      "Shelf-based connector browsing in the chat composer and on the connectors page: a Discover/Your connectors scope segment with one filter each (category and agent), category shelves and chips, per-connector detail, and keyboard navigation.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatThreadHeaderActions]: {
    maintainer: "lancy@okou.ai",
    description:
      "Pin chats from the desktop title and keep Pin, Share, and More visible in the mobile thread header.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ComposerSlashTemplatePanel]: {
    maintainer: "tongx@okou.ai",
    description:
      "Replace the composer's flat slash menu with a two-pane panel that previews each template type's covers.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ComposerTemplateChipCover]: {
    maintainer: "tongx@okou.ai",
    description:
      "Show the chosen template's cover image on the composer's inline template chip instead of a generic glyph.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
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
        result[key as FeatureSwitchKey] = value;
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
 * Client-side callers should usually read the platform `featureSwitch$` signal
 * instead — it also merges DB overrides on top of identity context.
 */
export function isFeatureEnabled(
  key: FeatureSwitchKey,
  ctx: FeatureSwitchContext,
): boolean {
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
