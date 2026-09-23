import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

interface UseCase {
  readonly id: string;
  readonly prompt: string;
  readonly connectorSlugs?: readonly ConnectorSlug[];
  readonly featureFlag?: FeatureSwitchKey;
}

interface Category {
  readonly id: string;
  readonly cases: readonly UseCase[];
}

interface IdeationFilterOptions {
  readonly features?: Partial<Record<FeatureSwitchKey, boolean>>;
  readonly visibleConnectorSlugs?: ReadonlySet<string>;
}

const categories: readonly Category[] = [
  {
    id: "engineering",
    cases: [
      {
        id: "daily-standup-report",
        prompt:
          "Set up a daily standup report that pulls data from GitHub, Sentry, Axiom, and Plausible every morning, generates a pptx, and posts it to #team-updates",
        connectorSlugs: ["github", "sentry", "axiom", "plausible", "slack"],
      },
      {
        id: "github-progress-weekly",
        prompt:
          "Generate a weekly GitHub progress report summarized by feature modules",
        connectorSlugs: ["github"],
      },
      {
        id: "github-pr-summarizer",
        prompt:
          "Summarize all merged GitHub PRs from the past week and save a daily report in Notion with an optional Slack post",
        connectorSlugs: ["github", "notion", "slack"],
      },
      {
        id: "sentry-issue-digest",
        prompt:
          "Set up a daily Sentry issue digest that summarizes critical and high severity issues every morning and posts to Slack",
        connectorSlugs: ["sentry", "slack"],
      },
      {
        id: "vercel-deploy-digest",
        prompt:
          "Set up a Vercel deploy digest that monitors deployments, links each to its GitHub commit, and sends Slack alerts on failures",
        connectorSlugs: ["vercel", "github", "slack"],
      },
      {
        id: "cloudflare-traffic-security-report",
        prompt:
          "Set up a weekly Cloudflare report that summarizes traffic analytics, WAF events, and bot activity, then posts to Slack",
        connectorSlugs: ["cloudflare", "slack"],
      },
      {
        id: "batch-create-issues",
        prompt:
          "Create the following GitHub issues and assign them to the right people: 1) ... 2) ... 3) ...",
        connectorSlugs: ["github"],
      },
      {
        id: "codebase-investigation",
        prompt:
          "Look at this page and search the codebase to find the root cause of the bug: [paste URL]",
        connectorSlugs: ["github"],
      },
      {
        id: "deep-research-code-analysis",
        prompt:
          "Do a deep research on how the agent run queue locking mechanism works in our codebase",
        connectorSlugs: ["github"],
      },
      {
        id: "security-dependency-alert-digest",
        prompt:
          "Generate a weekly GitHub security and dependency alert digest and post it to Slack",
        connectorSlugs: ["github", "slack"],
      },
      {
        id: "jira-github-issue-sync",
        prompt:
          "Set up a bidirectional sync between Jira and GitHub so that issue status, labels, and comments stay in sync across both platforms",
        connectorSlugs: ["jira", "github", "slack"],
      },
      {
        id: "gitlab-to-github-migration-helper",
        prompt:
          "Set up a workflow that mirrors GitLab issues to GitHub issues and notifies on Slack when new items are synced",
        connectorSlugs: ["gitlab", "github", "slack"],
      },
      {
        id: "browserbase-web-testing",
        prompt:
          "Set up automated browser tests using Browserbase that check our landing page, login flow, and dashboard every day and report failures to Slack",
        connectorSlugs: ["browserbase", "slack"],
      },
      {
        id: "zapier-okou-migration",
        prompt:
          "Help me migrate my Zapier workflows to Okou. I have zaps for: new Slack message → Notion, Gmail → Google Sheets, and GitHub PR → Slack",
        connectorSlugs: ["zapier", "slack", "notion"],
        featureFlag: FeatureSwitchKey.ZapierConnector,
      },
      {
        id: "make-scenario-builder",
        prompt:
          "Design a Make scenario that watches a Gmail inbox for invoices, extracts amounts and dates, logs them to Google Sheets, and alerts on Slack",
        connectorSlugs: ["make", "gmail", "google-sheets", "slack"],
      },
    ],
  },
  {
    id: "product",
    cases: [
      {
        id: "product-copy-naming",
        prompt:
          'Suggest user-friendly alternative names for "logs" in our product UI',
      },
      {
        id: "pricing-analysis",
        prompt:
          "Analyze the pricing strategy of Claude Code and compare it with similar products",
      },
      {
        id: "linear-prd-implementer",
        prompt:
          "Take the product spec from Notion and create a structured Linear project with epics and issues",
        connectorSlugs: ["notion", "linear"],
      },
      {
        id: "feedback-router",
        prompt:
          "Set up a feedback router that watches a Slack channel and routes messages to the right team based on keywords and labels",
        connectorSlugs: ["slack", "notion"],
      },
      {
        id: "metabase-dashboard-digest",
        prompt:
          "Set up a weekly Metabase digest that snapshots key dashboards, captures charts, and posts them to Slack every Monday morning",
        connectorSlugs: ["metabase", "slack"],
      },
      {
        id: "asana-notion-project-sync",
        prompt:
          "Set up a sync between Asana and Notion that mirrors project milestones, task progress, and due dates into a Notion dashboard",
        connectorSlugs: ["asana", "notion", "slack"],
      },
    ],
  },
  {
    id: "marketing",
    cases: [
      {
        id: "content-planner",
        prompt:
          "Help me brainstorm content ideas and plan an editorial calendar for the next month in Notion",
        connectorSlugs: ["notion"],
      },
      {
        id: "marketing-content-planning",
        prompt:
          "Help me plan GTM use case content. Reference our team's Slack usage patterns, user interviews, and competitor analysis",
        connectorSlugs: ["slack"],
      },
      {
        id: "onboarding-email-use-cases",
        prompt:
          "Analyze our Slack usage records and user interviews to extract key onboarding use cases for email campaigns",
        connectorSlugs: ["slack"],
      },
      {
        id: "competitor-research-to-notion",
        prompt:
          "Research competitor [name] on X/Twitter and save the findings into our Notion research database",
        connectorSlugs: ["x", "notion"],
      },
      {
        id: "social-media-content-calendar",
        prompt:
          "Generate social media content for Twitter and LinkedIn from my Google Sheets content calendar and schedule the posts",
        connectorSlugs: ["google-sheets", "x"],
      },
      {
        id: "youtube-to-x-thread-repurposer",
        prompt:
          "Set up a workflow that monitors my YouTube channel for new videos, creates a summary page in Notion, and generates a promotional X thread",
        connectorSlugs: ["youtube", "notion", "x"],
      },
      {
        id: "competitive-intel-scraper",
        prompt:
          "Set up a weekly competitor scraper using Firecrawl that monitors competitor websites for pricing and feature changes, saves findings to Notion, and alerts on Slack",
        connectorSlugs: ["firecrawl", "notion", "slack"],
      },
      {
        id: "dev-to-auto-publisher",
        prompt:
          "Set up a workflow that publishes Notion pages tagged as 'ready' to Dev.to and posts a link on X",
        connectorSlugs: ["devto", "notion", "x"],
      },
      {
        id: "instagram-engagement-tracker",
        prompt:
          "Set up an Instagram tracker that logs post engagement metrics to Google Sheets and posts a weekly summary to Slack",
        connectorSlugs: ["instagram", "google-sheets", "slack"],
      },
      {
        id: "similarweb-traffic-comparison",
        prompt:
          "Run a monthly SimilarWeb traffic comparison between our site and top 5 competitors, save the report to Notion",
        connectorSlugs: ["similarweb", "notion"],
      },
      {
        id: "serpapi-keyword-tracker",
        prompt:
          "Set up a weekly keyword ranking tracker using SerpAPI that monitors our target keywords and logs position changes to Google Sheets with a Slack summary",
        connectorSlugs: ["serpapi", "google-sheets", "slack"],
      },
      {
        id: "apify-web-scraper-to-sheets",
        prompt:
          "Set up an Apify scraper that extracts product listings from a competitor website and saves them to Google Sheets daily",
        connectorSlugs: ["apify", "google-sheets", "slack"],
      },
      {
        id: "marketing-automation-system",
        prompt:
          "Set up a marketing automation system with three agents: a daily researcher for information collection, a weekly monitor for tracking, and an on-demand agent for ad-hoc tasks",
        connectorSlugs: ["slack"],
      },
      {
        id: "discord-community-insights",
        prompt:
          "Set up a Discord community monitor that watches for feature requests and bug reports, categorizes them in Notion, and posts a weekly digest to Slack",
        connectorSlugs: ["discord", "notion", "slack"],
      },
      {
        id: "x-brand-monitor",
        prompt:
          "Set up an X brand monitor that watches for mentions of our product, saves relevant posts to Notion, and sends Slack alerts for high-engagement posts",
        connectorSlugs: ["x", "notion", "slack"],
      },
      {
        id: "loops-email-campaign",
        prompt:
          "Set up a workflow that drafts email campaigns from Notion content and sends them through Loops",
        connectorSlugs: ["loops", "notion"],
      },
      {
        id: "brevo-email-nurture-sequence",
        prompt:
          "Set up a Brevo nurture sequence that sends onboarding emails when new contacts are added to a Notion database",
        connectorSlugs: ["brevo", "notion", "slack"],
      },
    ],
  },
  {
    id: "creative",
    cases: [
      {
        id: "elevenlabs-audio-content",
        prompt:
          "Set up a workflow that takes blog posts from Notion, generates voice narration with ElevenLabs, and saves the audio to Google Drive",
        connectorSlugs: ["elevenlabs", "notion", "google-drive"],
      },
      {
        id: "heygen-video-from-script",
        prompt:
          "Set up a workflow that takes a script from Notion, generates a video with HeyGen, and sends a Slack notification when it's ready",
        connectorSlugs: ["heygen", "notion", "slack"],
      },
      {
        id: "runway-video-from-brief",
        prompt:
          "Take a creative brief from Notion and generate a short promotional video using Runway, then notify the team on Slack when ready",
        connectorSlugs: ["runway", "notion", "slack"],
      },
      {
        id: "fal-ai-image-generation",
        prompt:
          "Set up a workflow that takes product descriptions from Notion, generates marketing images using Fal, and saves them to Google Drive",
        connectorSlugs: ["fal", "notion", "google-drive"],
      },
      {
        id: "cloudinary-media-optimizer",
        prompt:
          "Set up a workflow that takes images from Google Drive, optimizes them with Cloudinary for web use, and logs the results in Notion",
        connectorSlugs: ["cloudinary", "google-drive", "notion"],
      },
    ],
  },
  {
    id: "sales",
    cases: [
      {
        id: "streak-pipeline-report",
        prompt:
          "Set up a weekly Streak pipeline report that summarizes deal stages, win rates, and upcoming follow-ups, then posts to Slack",
        connectorSlugs: ["streak", "slack"],
      },
      {
        id: "lead-follow-up-pipeline",
        prompt:
          "Set up a lead follow-up pipeline that monitors Gmail for new leads, analyzes them with AI, creates HubSpot tasks, and notifies the sales team on Slack",
        connectorSlugs: ["gmail", "hubspot", "slack"],
      },
      {
        id: "win-loss-reporter",
        prompt:
          "Set up a weekly win/loss report that analyzes our HubSpot pipeline, tracks deal outcomes, and posts trends to Slack",
        connectorSlugs: ["hubspot", "slack"],
      },
      {
        id: "salesforce-pipeline-digest",
        prompt:
          "Set up a weekly Salesforce pipeline digest that summarizes new opportunities, stage changes, and close dates, then posts to Slack",
        connectorSlugs: ["salesforce", "slack"],
      },
      {
        id: "airtable-deal-tracker",
        prompt:
          "Set up an Airtable deal tracker that syncs deal records to Google Sheets and sends a Slack notification when a deal is marked as closed-won",
        connectorSlugs: ["airtable", "google-sheets", "slack"],
      },
      {
        id: "hubspot-sales-reporter",
        prompt:
          "Generate a weekly HubSpot sales summary and save it as a structured report in Notion",
        connectorSlugs: ["hubspot", "notion"],
      },
      {
        id: "bitrix24-lead-nurture",
        prompt:
          "Set up a lead nurture workflow that monitors Bitrix24 for new leads, creates follow-up tasks, and notifies sales on Slack",
        connectorSlugs: ["bitrix", "slack"],
      },
    ],
  },
  {
    id: "support",
    cases: [
      {
        id: "support-ticket-router",
        prompt:
          "Set up a support ticket router that monitors Gmail for support emails, classifies them by category and priority, creates Notion entries, and sends Slack alerts for critical tickets",
        connectorSlugs: ["gmail", "notion", "slack"],
      },
      {
        id: "intercom-conversation-triager",
        prompt:
          "Set up a workflow that takes Intercom conversations, classifies them, and creates structured tasks in Notion",
        connectorSlugs: ["intercom", "notion"],
      },
      {
        id: "zendesk-notion-knowledge-base",
        prompt:
          "Set up a workflow that identifies recurring Zendesk questions, drafts FAQ entries, and adds them to our Notion knowledge base",
        connectorSlugs: ["zendesk", "notion", "slack"],
      },
      {
        id: "customer-support-bot",
        prompt:
          "Set up a customer support bot that answers questions from our Notion knowledge base and creates tasks for unanswered questions",
        connectorSlugs: ["slack", "notion"],
      },
      {
        id: "chatwoot-notion-support-log",
        prompt:
          "Set up a workflow that takes Chatwoot customer conversations, categorizes them by topic, and creates structured entries in Notion",
        connectorSlugs: ["chatwoot", "notion", "slack"],
      },
    ],
  },
  {
    id: "ops",
    cases: [
      {
        id: "revenuecat-subscription-digest",
        prompt:
          "Set up a daily RevenueCat digest that tracks new subscriptions, renewals, and cancellations in Google Sheets and alerts on Slack for churn spikes",
        connectorSlugs: ["revenuecat", "google-sheets", "slack"],
      },
      {
        id: "xero-financial-summary",
        prompt:
          "Set up a weekly Xero financial summary that pulls profit & loss and cash flow data and posts a formatted report to Slack",
        connectorSlugs: ["xero", "slack"],
      },
      {
        id: "pdf-contract-processor",
        prompt:
          "Set up a workflow that processes PDF contracts, extracts key dates and terms into Notion, and sends Slack reminders before expiration dates",
        connectorSlugs: ["pdfco", "notion", "slack"],
      },
      {
        id: "jotform-intake-to-notion",
        prompt:
          "Set up a Jotform intake that routes new form submissions to the right Notion database and sends a Slack notification",
        connectorSlugs: ["jotform", "notion", "slack"],
      },
      {
        id: "google-drive-file-organizer",
        prompt:
          "Set up a workflow that watches Google Drive for new files, classifies them by content, and moves them into the right folders",
        connectorSlugs: ["google-drive"],
      },
      {
        id: "google-docs-notion-migrator",
        prompt:
          "Set up a workflow that converts a folder of Google Docs into Notion pages, preserving headings, tables, and images",
        connectorSlugs: ["google-docs", "notion"],
      },
      {
        id: "monday-com-weekly-digest",
        prompt:
          "Set up a weekly Monday.com digest that summarizes board activity, completed items, and blockers, then posts to Slack",
        connectorSlugs: ["monday", "slack"],
      },
      {
        id: "wrike-project-reporter",
        prompt:
          "Set up a weekly Wrike report that summarizes task completion, overdue items, and blockers across all projects, then posts to Slack",
        connectorSlugs: ["wrike", "slack"],
      },
      {
        id: "todoist-notion-task-sync",
        prompt:
          "Set up a sync that mirrors my Todoist tasks into a Notion database so the team can see what I'm working on",
        connectorSlugs: ["todoist", "notion"],
      },
      {
        id: "clickup-slack-standups",
        prompt:
          "Set up a daily standup that pulls each team member's tasks from ClickUp and posts a formatted summary to Slack every morning",
        connectorSlugs: ["clickup", "slack"],
      },
      {
        id: "agentmail-inbox",
        prompt:
          "Create a new AgentMail inbox and set up email forwarding rules",
        connectorSlugs: ["agentmail"],
      },
    ],
  },
  {
    id: "everyone",
    cases: [
      {
        id: "personal-weekly-digest",
        prompt:
          "Create a personal weekly report workflow that merges GitHub PRs, Gmail, and Calendar data into a summary and sends it to Slack",
        connectorSlugs: ["github", "gmail", "google-calendar", "slack"],
      },
      {
        id: "morning-brief",
        prompt:
          "Set up a morning brief that pulls updates from Gmail, Calendar, and Notion every morning and posts a daily plan to Slack",
        connectorSlugs: ["gmail", "google-calendar", "notion", "slack"],
      },
      {
        id: "strava-team-fitness-digest",
        prompt:
          "Set up a weekly Strava digest that summarizes team members' running and cycling activities and posts a leaderboard to Slack",
        connectorSlugs: ["strava", "slack"],
      },
      {
        id: "email-assistant",
        prompt:
          "Set up a daily email assistant that summarizes my inbox every morning and suggests actions for each thread",
        connectorSlugs: ["gmail"],
      },
      {
        id: "calendar-optimizer",
        prompt:
          "Analyze my calendar for today and recommend how to manage conflicts, prevent overload, and schedule focus time",
        connectorSlugs: ["google-calendar"],
      },
      {
        id: "send-messages-on-your-behalf",
        prompt:
          "Send a message to the team on my behalf: I'll be taking a day off tomorrow. Please reach out to [name] for urgent matters.",
        connectorSlugs: ["slack"],
      },
      {
        id: "browser-screenshots",
        prompt:
          "Open this URL in the browser and take a screenshot: [paste URL]",
      },
      {
        id: "self-update-instructions",
        prompt: "Update yourself: add the following instructions — ...",
      },
      {
        id: "meeting-notes-pipeline",
        prompt:
          "Set up a meeting notes pipeline that takes Fireflies transcripts, generates a summary in Notion, and posts action items to Slack after each meeting",
        connectorSlugs: ["fireflies", "notion", "slack"],
      },
      {
        id: "calendly-booking-sync",
        prompt:
          "Set up a Calendly sync that adds new bookings to Google Calendar and sends a Slack notification with meeting details",
        connectorSlugs: ["calendly", "google-calendar", "slack"],
      },
      {
        id: "lark-slack-message-relay",
        prompt:
          "Set up a message relay between a Lark group and a Slack channel so that messages are forwarded both ways",
        connectorSlugs: ["lark", "slack"],
      },
      {
        id: "line-message-relay",
        prompt:
          "Set up a message relay between a LINE group and a Slack channel so messages flow both ways",
        connectorSlugs: ["line", "slack"],
      },
      {
        id: "tl-dv-meeting-recap",
        prompt:
          "Set up a workflow that takes tl;dv meeting recordings, generates a summary with action items in Notion, and posts highlights to Slack",
        connectorSlugs: ["tldv", "notion", "slack"],
      },
      {
        id: "granola-notes-to-notion",
        prompt:
          "Set up a sync that takes meeting notes from Granola and organizes them in a Notion database grouped by project",
        connectorSlugs: ["granola", "notion"],
      },
      {
        id: "perplexity-deep-research",
        prompt:
          "Use Perplexity to research a topic in depth, compile findings into a structured Notion page with sources and key insights",
        connectorSlugs: ["perplexity", "notion"],
      },
      {
        id: "tavily-web-research-pipeline",
        prompt:
          "Use Tavily to research the latest trends in AI agents, compile a structured report in Notion with sources and key takeaways",
        connectorSlugs: ["tavily", "notion"],
      },
    ],
  },
];

/** Every connector a use case names, so their visibility is asked for at once. */
export const IDEATION_CONNECTOR_SLUGS: readonly ConnectorSlug[] = [
  ...new Set(
    categories.flatMap((category) => {
      return category.cases.flatMap((useCase) => {
        return useCase.connectorSlugs ?? [];
      });
    }),
  ),
];

function isEnabled(
  useCase: UseCase,
  features?: Partial<Record<FeatureSwitchKey, boolean>>,
): boolean {
  if (!useCase.featureFlag) {
    return true;
  }
  return !!features?.[useCase.featureFlag];
}

function filterUseCase(
  useCase: UseCase,
  options: IdeationFilterOptions,
): UseCase | null {
  const visibleConnectorSlugs = options.visibleConnectorSlugs;
  if (!isEnabled(useCase, options.features)) {
    return null;
  }

  if (
    !useCase.connectorSlugs ||
    useCase.connectorSlugs.length === 0 ||
    !visibleConnectorSlugs
  ) {
    return useCase;
  }

  const allConnectorsVisible = useCase.connectorSlugs.every((connectorSlug) => {
    return visibleConnectorSlugs.has(connectorSlug);
  });
  if (!allConnectorsVisible) {
    return null;
  }
  return useCase;
}

export function getCategories(
  options: IdeationFilterOptions,
): readonly Category[] {
  return categories
    .map((c) => {
      return {
        ...c,
        cases: c.cases.flatMap((u) => {
          const useCase = filterUseCase(u, options);
          return useCase ? [useCase] : [];
        }),
      };
    })
    .filter((c) => {
      return c.cases.length > 0;
    });
}
