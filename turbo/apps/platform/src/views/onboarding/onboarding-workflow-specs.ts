import type { OnboardingWorkflowConnectorSlug } from "@okouai/api-contracts/contracts/onboarding";

export type OnboardingWorkflowCategoryId =
  | "engineering"
  | "product"
  | "data"
  | "marketing"
  | "sales"
  | "support"
  | "ceo"
  | "operations"
  | "everyone";

export interface OnboardingWorkflowSpec {
  readonly id: string;
  readonly prompt: string;
  // The API serves labels and icons for exactly this shared slug list.
  readonly requiredConnectorSlugs: readonly OnboardingWorkflowConnectorSlug[];
  readonly optionalConnectorSlugs?: readonly OnboardingWorkflowConnectorSlug[];
}

// Onboarding owns a focused six-workflow catalog per role. Keeping its prompt
// and connector requirements together prevents the setup UI from drifting from
// the workflow the user selected.
export const ONBOARDING_WORKFLOW_SPECS = {
  engineering: [
    {
      id: "auto-merge-github-prs",
      prompt:
        "Create an automation for pull requests labeled ready-to-merge. Review the diff, wait for required CI checks, and merge only after the user confirms that the workflow may merge and chooses a merge method. Include Vercel deployment checks when available.",
      requiredConnectorSlugs: ["github"],
      optionalConnectorSlugs: ["vercel"],
    },
    {
      id: "file-sentry-crashes-github",
      prompt:
        "Create a scheduled workflow that ranks new Sentry crashes by affected users and severity, files actionable GitHub issues for the highest-impact crashes, and optionally links the resulting work in Linear.",
      requiredConnectorSlugs: ["sentry", "github"],
      optionalConnectorSlugs: ["linear"],
    },
    {
      id: "watch-sentry-after-release",
      prompt:
        "Create a post-release workflow that compares the latest release's Sentry crash-free rate and new regressions with the previous baseline. Use GitHub and Vercel release context when available and recommend whether to watch, fix forward, or roll back.",
      requiredConnectorSlugs: ["sentry"],
      optionalConnectorSlugs: ["github", "vercel"],
    },
    {
      id: "post-github-updates-slack",
      prompt:
        "Create a weekly Google Cloud security review that checks project IAM bindings, service accounts, service account keys, enabled services, and public exposure. Summarize privilege drift and recommended remediation, and optionally file approved findings as GitHub issues. Keep the workflow read-only unless the user explicitly approves a specific change.",
      requiredConnectorSlugs: ["google-cloud"],
      optionalConnectorSlugs: ["github"],
    },
    {
      id: "draft-github-release-notes-notion",
      prompt:
        "Create a release-note workflow that gathers GitHub pull requests merged since the previous release and writes a concise, user-facing changelog in Notion.",
      requiredConnectorSlugs: ["github", "notion"],
    },
    {
      id: "report-ai-model-costs-slack",
      prompt:
        "Create a Cloudflare incident workflow that reviews traffic, security events, and service health, explains likely impact and next actions in the automation thread, and optionally files a GitHub issue for confirmed incidents.",
      requiredConnectorSlugs: ["cloudflare"],
      optionalConnectorSlugs: ["github"],
    },
  ],
  product: [
    {
      id: "github-idea-to-notion-spec",
      prompt:
        "Create a workflow that expands a labeled GitHub idea into a structured product specification in Notion, including the problem, evidence, scope, success metrics, risks, and open questions.",
      requiredConnectorSlugs: ["github", "notion"],
    },
    {
      id: "summarize-user-feedback-notion",
      prompt:
        "Create a workflow that reads new Google Forms feedback, clusters responses into themes and recurring pain points, ranks the findings, and writes the summary in Notion.",
      requiredConnectorSlugs: ["google-forms", "notion"],
    },
    {
      id: "post-release-notes-slack",
      prompt:
        "Create a workflow that turns recently shipped GitHub work into readable release notes and publishes the approved draft in Notion.",
      requiredConnectorSlugs: ["github", "notion"],
    },
    {
      id: "sync-linear-roadmap-notion",
      prompt:
        "Create a scheduled workflow that maps Linear projects and issues into a Now, Next, and Later roadmap and keeps the corresponding Notion page current.",
      requiredConnectorSlugs: ["linear", "notion"],
    },
    {
      id: "track-feature-usage-posthog",
      prompt:
        "Create a weekly workflow that identifies the largest changes in feature adoption from Google Analytics and optionally saves the analysis and follow-up questions in Notion.",
      requiredConnectorSlugs: ["google-analytics"],
      optionalConnectorSlugs: ["notion"],
    },
    {
      id: "flag-figma-designs-no-task",
      prompt:
        "Create a workflow that turns an approved Notion product specification into a Linear project with milestones, scoped issues, dependencies, and acceptance criteria. Optionally link relevant GitHub context.",
      requiredConnectorSlugs: ["notion", "linear"],
      optionalConnectorSlugs: ["github"],
    },
  ],
  data: [
    {
      id: "post-daily-metrics-slack",
      prompt:
        "Create a daily workflow that summarizes website traffic, acquisition, conversion, and notable changes from Google Analytics, with optional organic-search context from Google Search Console. Return the brief in the automation thread.",
      requiredConnectorSlugs: ["google-analytics"],
      optionalConnectorSlugs: ["google-search-console"],
    },
    {
      id: "run-daily-query-sheets",
      prompt:
        "Create a scheduled workflow that writes Google Search Console clicks, impressions, click-through rate, position, and winning or declining queries into Google Sheets, with optional Google Analytics landing-page context.",
      requiredConnectorSlugs: ["google-search-console", "google-sheets"],
      optionalConnectorSlugs: ["google-analytics"],
    },
    {
      id: "check-posthog-signup-funnel",
      prompt:
        "Create a workflow that compares Google Ads and Meta Ads spend, conversions, CPA, and ROAS for the same reporting window and optionally writes the normalized comparison to Google Sheets.",
      requiredConnectorSlugs: ["google-ads", "meta-ads"],
      optionalConnectorSlugs: ["google-sheets"],
    },
    {
      id: "alert-metric-moves-slack",
      prompt:
        "Create a monitoring workflow that finds material traffic and conversion shifts in Google Analytics, adds relevant search and paid-channel context when connected, and explains anomalies in the automation thread.",
      requiredConnectorSlugs: ["google-analytics"],
      optionalConnectorSlugs: [
        "google-search-console",
        "google-ads",
        "meta-ads",
      ],
    },
    {
      id: "track-signup-sources-sheets",
      prompt:
        "Create an advanced data workflow that queries a selected BigQuery dataset through Google Cloud, identifies trends and anomalies, and writes a refreshable result table and summary to Google Sheets. Use Google Analytics only when the user wants web context joined to the query.",
      requiredConnectorSlugs: ["google-cloud", "google-sheets"],
      optionalConnectorSlugs: ["google-analytics"],
    },
    {
      id: "build-weekly-deck-gamma",
      prompt:
        "Create a scheduled finance workflow that pulls key QuickBooks revenue, expense, receivables, and cash-flow metrics and writes a decision-ready dashboard to Google Sheets.",
      requiredConnectorSlugs: ["quickbooks", "google-sheets"],
    },
  ],
  marketing: [
    {
      id: "track-keyword-ranks-ahrefs",
      prompt:
        "Create a technical SEO audit workflow that uses the built-in Firecrawl and DataForSEO capabilities to crawl a site, inspect indexability and internal links, validate key pages against live search results, and return a prioritized issue list. Do not request a connector.",
      requiredConnectorSlugs: [],
    },
    {
      id: "publish-scheduled-posts-buffer",
      prompt:
        "Create an SEO research workflow that uses the built-in Firecrawl and DataForSEO capabilities to compare the user's site with named competitors, identify keyword and content gaps, and rank opportunities by intent and likely value. Do not request a connector.",
      requiredConnectorSlugs: [],
    },
    {
      id: "blog-posts-to-x",
      prompt:
        "Create an SEO content-refresh workflow that uses the built-in Firecrawl and DataForSEO capabilities to find decaying or underperforming pages, map current search demand, and produce a prioritized update brief for each page. Do not request a connector.",
      requiredConnectorSlugs: [],
    },
    {
      id: "draft-newsletter-mailchimp",
      prompt:
        "Create a recurring organic-growth workflow that combines Google Analytics and Google Search Console into a concise performance brief and optionally saves decisions and follow-up work in Notion.",
      requiredConnectorSlugs: ["google-analytics", "google-search-console"],
      optionalConnectorSlugs: ["notion"],
    },
    {
      id: "compare-google-ads-last-month",
      prompt:
        "Create a recurring paid-media workflow that compares Google Ads and Meta Ads performance, highlights budget or efficiency drift, and optionally writes the normalized results to Google Sheets.",
      requiredConnectorSlugs: ["google-ads", "meta-ads"],
      optionalConnectorSlugs: ["google-sheets"],
    },
    {
      id: "watch-brand-mentions",
      prompt:
        "Create a content-repurposing workflow that reviews a selected YouTube video, drafts platform-native X posts and threads, and optionally saves the approved content plan in Notion. Keep publishing subject to explicit user approval.",
      requiredConnectorSlugs: ["youtube", "x"],
      optionalConnectorSlugs: ["notion"],
    },
  ],
  sales: [
    {
      id: "new-gmail-contacts-hubspot",
      prompt:
        "Create a workflow that detects relevant new Gmail correspondents, checks for an existing HubSpot record, and creates or enriches the contact.",
      requiredConnectorSlugs: ["gmail", "hubspot"],
    },
    {
      id: "research-new-signups-apollo",
      prompt:
        "Create a lead-generation workflow that finds creators and prospects on X who match the user's target profile, then qualifies each candidate with the built-in Perplexity people search and Firecrawl capabilities to confirm role, company, audience, and recent work. Score fit, return a ranked outreach list with a personalized opening message for human review, and optionally save qualified leads to HubSpot. Do not request a separate research or enrichment connector, and never send outreach automatically.",
      requiredConnectorSlugs: ["x"],
      optionalConnectorSlugs: ["hubspot"],
    },
    {
      id: "gmail-followups-auto",
      prompt:
        "Create a workflow that reviews HubSpot deal context and the related Gmail thread, then drafts a concise follow-up email for human review. Use Google Calendar when meeting timing is relevant and never send automatically.",
      requiredConnectorSlugs: ["gmail", "hubspot"],
      optionalConnectorSlugs: ["google-calendar"],
    },
    {
      id: "prep-google-calendar-meetings",
      prompt:
        "Create a pre-meeting workflow that reviews upcoming Google Calendar events, enriches attendee context from HubSpot when available, and produces a short briefing in the automation thread.",
      requiredConnectorSlugs: ["google-calendar"],
      optionalConnectorSlugs: ["hubspot"],
    },
    {
      id: "log-gong-calls-hubspot",
      prompt:
        "Create a workflow that turns new Google Meet transcripts into decisions, objections, commitments, and action items in HubSpot, with an optional Gmail follow-up draft for human review.",
      requiredConnectorSlugs: ["google-meet", "hubspot"],
      optionalConnectorSlugs: ["gmail"],
    },
    {
      id: "catch-leads-gmail",
      prompt:
        "Create a weekly HubSpot pipeline workflow that summarizes stage movement, stale deals, risks, next actions, and forecast changes, and optionally writes the snapshot to Google Sheets.",
      requiredConnectorSlugs: ["hubspot"],
      optionalConnectorSlugs: ["google-sheets"],
    },
  ],
  support: [
    {
      id: "sort-route-zendesk-tickets",
      prompt:
        "Create a workflow that classifies new support emails in Gmail, sets priority and ownership, creates actionable Linear issues, and optionally checks Notion for product or policy context.",
      requiredConnectorSlugs: ["gmail", "linear"],
      optionalConnectorSlugs: ["notion"],
    },
    {
      id: "draft-replies-notion-faq",
      prompt:
        "Create a workflow that reads support questions from Gmail, finds grounded answers in a Notion FAQ, and drafts replies for human review. Never send automatically.",
      requiredConnectorSlugs: ["gmail", "notion"],
    },
    {
      id: "send-bugs-github-slack",
      prompt:
        "Create a workflow that detects reproducible bug reports in support emails, files structured GitHub issues with evidence and impact, and optionally links the work in Linear.",
      requiredConnectorSlugs: ["gmail", "github"],
      optionalConnectorSlugs: ["linear"],
    },
    {
      id: "fixes-to-notion-help-docs",
      prompt:
        "Create a workflow that turns recently resolved GitHub bugs into clear, reusable troubleshooting or help articles in Notion.",
      requiredConnectorSlugs: ["github", "notion"],
    },
    {
      id: "spot-churn-risk-stripe-zendesk",
      prompt:
        "Create a daily support workflow that summarizes new and unresolved Gmail conversations, highlights risk and recurring themes, and adds related Linear or GitHub work when available.",
      requiredConnectorSlugs: ["gmail"],
      optionalConnectorSlugs: ["linear", "github"],
    },
    {
      id: "summarize-zendesk-tickets-daily",
      prompt:
        "Create a no-connector workflow that turns approved FAQ content into short digital-human support videos with the built-in avatar-video capability. Draft the script and storyboard first, then generate only after the user approves them. Do not request an avatar provider connector.",
      requiredConnectorSlugs: [],
    },
  ],
  ceo: [
    {
      id: "daily-company-brief-slack",
      prompt:
        "Create a daily company-pulse workflow that combines Google Analytics growth signals with HubSpot pipeline context, adds QuickBooks financial context when connected, and returns wins, risks, and decisions in the automation thread.",
      requiredConnectorSlugs: ["google-analytics", "hubspot"],
      optionalConnectorSlugs: ["quickbooks"],
    },
    {
      id: "daily-industry-news-slack",
      prompt:
        "Create a finance-monitoring workflow that checks QuickBooks cash flow, accounts receivable, and overdue invoices, explains material risk in the automation thread, and optionally drafts Gmail follow-ups for human review.",
      requiredConnectorSlugs: ["quickbooks"],
      optionalConnectorSlugs: ["gmail"],
    },
    {
      id: "business-review-gamma",
      prompt:
        "Create a monthly business-review workflow that combines QuickBooks financials, Google Analytics growth, and a Google Sheets operating model into a concise review, with optional HubSpot pipeline context.",
      requiredConnectorSlugs: [
        "quickbooks",
        "google-analytics",
        "google-sheets",
      ],
      optionalConnectorSlugs: ["hubspot"],
    },
    {
      id: "highlight-key-emails-gmail",
      prompt:
        "Create a workflow that finds the Gmail messages that most need an executive response, summarizes why each matters, and uses Google Calendar context when available. Draft responses but never send automatically.",
      requiredConnectorSlugs: ["gmail"],
      optionalConnectorSlugs: ["google-calendar"],
    },
    {
      id: "investor-update-google-docs",
      prompt:
        "Create a monthly investor-update workflow that combines QuickBooks financials and Google Analytics growth into a concise draft in Google Docs, with optional HubSpot commercial context.",
      requiredConnectorSlugs: ["quickbooks", "google-analytics", "google-docs"],
      optionalConnectorSlugs: ["hubspot"],
    },
    {
      id: "gmail-reconnect-reminders",
      prompt:
        "Create a relationship-maintenance workflow that finds important Gmail contacts who have gone quiet, uses Google Calendar history when available, and drafts thoughtful reconnect messages for review.",
      requiredConnectorSlugs: ["gmail"],
      optionalConnectorSlugs: ["google-calendar"],
    },
  ],
  operations: [
    {
      id: "sync-asana-projects-notion",
      prompt:
        "Create a scheduled workflow that keeps a Notion project overview synchronized with selected Asana projects, including status, owners, due dates, blockers, and recent changes.",
      requiredConnectorSlugs: ["asana", "notion"],
    },
    {
      id: "meeting-notes-asana-tasks",
      prompt:
        "Create a workflow that turns new Google Meet transcripts into assigned Asana tasks with due dates and source context, using Google Calendar details when available.",
      requiredConnectorSlugs: ["google-meet", "asana"],
      optionalConnectorSlugs: ["google-calendar"],
    },
    {
      id: "file-gmail-invoices-drive",
      prompt:
        "Create a workflow that files invoice attachments from Gmail in Google Drive, records the bill or expense in QuickBooks, and optionally writes a reconciliation row to Google Sheets.",
      requiredConnectorSlugs: ["gmail", "google-drive", "quickbooks"],
      optionalConnectorSlugs: ["google-sheets"],
    },
    {
      id: "onboard-new-hires-asana",
      prompt:
        "Create a workflow that turns approved Google Forms new-hire submissions into an Asana onboarding plan and optionally files the person's documents in Google Drive.",
      requiredConnectorSlugs: ["google-forms", "asana"],
      optionalConnectorSlugs: ["google-drive"],
    },
    {
      id: "chase-overdue-asana-tasks",
      prompt:
        "Create a scheduled workflow that finds overdue Asana tasks, groups them by owner and project, and drafts concise Gmail reminders for human review. Never send automatically.",
      requiredConnectorSlugs: ["asana", "gmail"],
    },
    {
      id: "catch-calendar-conflicts",
      prompt:
        "Create a workflow that checks new Google Calendar events for double-bookings and impossible travel or preparation windows, then explains conflicts in the automation thread and optionally drafts a Gmail rescheduling note.",
      requiredConnectorSlugs: ["google-calendar"],
      optionalConnectorSlugs: ["gmail"],
    },
  ],
  everyone: [
    {
      id: "sort-gmail-draft-replies",
      prompt:
        "Create a workflow that triages new Gmail messages, groups them by urgency and requested action, and drafts replies for the messages that need a response. Never send automatically.",
      requiredConnectorSlugs: ["gmail"],
    },
    {
      id: "morning-brief-slack",
      prompt:
        "Create a morning workflow that combines the Gmail messages needing attention with the day's Google Calendar schedule and optionally adds relevant Notion context. Return the brief in the automation thread.",
      requiredConnectorSlugs: ["gmail", "google-calendar"],
      optionalConnectorSlugs: ["notion"],
    },
    {
      id: "research-calendar-meetings",
      prompt:
        "Create a pre-meeting workflow that reviews upcoming Google Calendar events, enriches attendee context from related Gmail threads when available, and produces a focused briefing.",
      requiredConnectorSlugs: ["google-calendar"],
      optionalConnectorSlugs: ["gmail"],
    },
    {
      id: "summarize-gmail-newsletters",
      prompt:
        "Create a scheduled workflow that summarizes selected Gmail newsletters into themes, important links, and recommended reads, and optionally saves the digest in Notion.",
      requiredConnectorSlugs: ["gmail"],
      optionalConnectorSlugs: ["notion"],
    },
    {
      id: "meeting-recaps-slack",
      prompt:
        "Create a workflow that turns new Google Meet transcripts into concise recaps and action items in Google Docs, using Google Calendar details when available.",
      requiredConnectorSlugs: ["google-meet", "google-docs"],
      optionalConnectorSlugs: ["google-calendar"],
    },
    {
      id: "flagged-gmail-todoist-tasks",
      prompt:
        "Create a workflow that turns Gmail messages with a selected label into Todoist tasks with clear titles, due dates, source links, and enough context to act.",
      requiredConnectorSlugs: ["gmail", "todoist"],
    },
  ],
} as const satisfies Readonly<
  Record<OnboardingWorkflowCategoryId, readonly OnboardingWorkflowSpec[]>
>;

export type OnboardingWorkflowId =
  (typeof ONBOARDING_WORKFLOW_SPECS)[OnboardingWorkflowCategoryId][number]["id"];
