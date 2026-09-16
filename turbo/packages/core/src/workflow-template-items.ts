import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";

export interface WorkflowTemplateItem {
  readonly id: `workflow-template:${string}`;
  readonly title: string;
  readonly description: string;
  // A one-clause version of the description. The template picker has room for
  // the full sentence; the chat landing card gets a 176px column beside its
  // thumbnail, which holds two lines and no more.
  readonly shortDescription: string;
  // Persona group used to organize the template picker. One of
  // WORKFLOW_TEMPLATE_CATEGORIES.
  readonly category: string;
  // Connector slugs shown as icons on the card. The catalog is curated by hand;
  // the picker filters these to entries with an icon. Every slug listed here
  // must expose an OAuth auth method: a template is a one-click start, and a
  // connector that can only be set up by pasting an API key is not.
  readonly connectorSlugs: readonly ConnectorSlug[];
  readonly promptGuidance: string;
}

// Ordered persona groups for the template picker. "Everyone" leads and holds the
// generic starter template; the rest mirror the onboarding personas.
export const WORKFLOW_TEMPLATE_CATEGORIES: readonly string[] = [
  "Everyone",
  "Engineering",
  "Product",
  "Data",
  "Marketing",
  "Sales",
  "Support",
  "CEO",
  "Operations",
];

// Built-in workflow templates. Each entry compiles into promptGuidance that
// instructs the agent to build a workflow (via the workflow-setup skill) rather
// than run a one-shot prompt. This set merges the curated gallery (#20409) with
// the persona-bucketed catalog derived from the onboarding cards.
function defineWorkflowTemplate(args: {
  readonly id: WorkflowTemplateItem["id"];
  readonly category: string;
  readonly title: string;
  readonly description: string;
  readonly shortDescription: string;
  readonly connectorSlugs: readonly ConnectorSlug[];
  readonly behavior: readonly string[];
  readonly missingInfo: string;
}): WorkflowTemplateItem {
  return {
    id: args.id,
    title: args.title,
    description: args.description,
    shortDescription: args.shortDescription,
    category: args.category,
    connectorSlugs: args.connectorSlugs,
    promptGuidance: [
      "# Workflow Template Context",
      "",
      `The user selected the built-in workflow template: ${args.title} (${args.id}).`,
      "Use the workflow-setup skill to help the user create or remix a workflow for this agent.",
      "Do not execute an existing workflow. This template is only context for creating or updating a workflow.",
      "Save the reusable workflow draft as soon as the template behavior is clear. Do not wait for connector setup or automation details.",
      "Keep the draft without an automation until the user confirms any missing trigger and safety choices.",
      "",
      "Template behavior:",
      ...args.behavior.map((line) => {
        return `- ${line}`;
      }),
      "",
      args.missingInfo,
    ].join("\n"),
  };
}

export const WORKFLOW_TEMPLATE_ITEMS: readonly WorkflowTemplateItem[] = [
  defineWorkflowTemplate({
    id: "workflow-template:auto-inbox-label",
    category: "Everyone",
    title: "Auto-inbox label",
    description:
      "Create a workflow that runs when a Gmail label is applied and handles the labeled inbox item.",
    shortDescription: "Run a workflow when you apply a Gmail label.",
    connectorSlugs: ["gmail"],
    behavior: [
      "Create a workflow that reacts when a named Gmail label is applied to a message.",
      "Treat the labeled message as the inbox item to process.",
      "Inspect the message context, decide the requested handling path, and prepare the appropriate follow-up.",
      "Add a Gmail label-applied automation for the workflow once the user confirms the label name.",
    ],
    missingInfo:
      "Connectors: gmail required.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the Gmail label name, handling rules, and final action.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:github-pr-summarizer",
    category: "Engineering",
    title: "GitHub PR summarizer",
    description:
      "Collect merged pull requests, save a structured report in Notion, and optionally post to Slack.",
    shortDescription: "Collect merged pull requests into a report.",
    connectorSlugs: ["github", "notion", "slack"],
    behavior: [
      "Create a daily or weekly scheduled workflow for one or more GitHub repositories.",
      "Find merged pull requests in the selected time window and group them by product or code area.",
      "Write a concise user-impact summary with links to the relevant pull requests.",
      "Save the report in Notion and optionally post a shorter version to Slack.",
    ],
    missingInfo:
      "Connectors: github, notion required; slack optional.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the repositories, cadence, timezone, Notion destination, Slack destination, and grouping rules.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:sentry-issue-digest",
    category: "Engineering",
    title: "Sentry issue digest",
    description:
      "Send a daily digest of critical and high-severity Sentry issues to Slack.",
    shortDescription: "Send a daily digest of critical Sentry issues.",
    connectorSlugs: ["sentry", "slack"],
    behavior: [
      "Create a daily scheduled workflow that checks selected Sentry projects.",
      "Group active issues by severity, recency, affected users, and ownership when available.",
      "Highlight regressions, repeated failures, and issues needing escalation.",
      "Post the digest to a Slack channel with links back to Sentry.",
    ],
    missingInfo:
      "Connectors: sentry, slack required.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the Sentry projects, severity threshold, schedule, timezone, and Slack channel.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:vercel-deploy-digest",
    category: "Engineering",
    title: "Vercel deploy digest",
    description:
      "Monitor Vercel deployments, link them to GitHub commits, and alert Slack on failures.",
    shortDescription: "Alert Slack when a Vercel deploy fails.",
    connectorSlugs: ["vercel", "github", "slack"],
    behavior: [
      "Create a workflow that monitors selected Vercel projects on a schedule or via webhook when available.",
      "Link deployments to GitHub commits, pull requests, and authors when possible.",
      "Summarize recent successful deployments and call out failed or stuck deployments.",
      "Send Slack alerts for failures and optionally send a periodic deployment digest.",
    ],
    missingInfo:
      "Connectors: vercel, slack required; github optional.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the Vercel projects, GitHub repositories, alert rules, cadence, and Slack channel.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:auto-merge-github-prs",
    category: "Engineering",
    title: "Auto-merge GitHub PRs",
    description:
      "Review PRs labeled ready-to-merge, wait for CI, then merge and post to Slack.",
    shortDescription: "Merge ready-to-merge PRs once CI passes.",
    connectorSlugs: ["github", "vercel", "slack"],
    behavior: [
      "A PR is labeled ready-to-merge",
      "Review the pull request and wait for CI",
      "Merged and posted to Slack",
    ],
    missingInfo:
      "Connectors: github required; vercel, slack optional.\nSuggested trigger: Add a github-pull-request event trigger with the labeled action on the ready-to-merge label so it runs the moment a PR is labeled.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask for the repository, whether the workflow may merge or should only recommend a merge, and the merge method. Ask only one short question at a time. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:file-sentry-crashes-github",
    category: "Engineering",
    title: "File Sentry crashes as GitHub issues",
    description:
      "Rank new Sentry errors by user impact and file the worst as GitHub issues.",
    shortDescription: "File the worst Sentry errors as GitHub issues.",
    connectorSlugs: ["sentry", "github", "linear", "slack"],
    behavior: [
      "Pull new Sentry errors",
      "Ranked by user impact",
      "Issues filed and owner pinged",
    ],
    missingInfo:
      "Connectors: sentry, github required; linear, slack optional.\nSuggested trigger: Add a schedule trigger (e.g. hourly). Sentry has no native event trigger yet, so poll on a cadence.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:draft-github-release-notes-notion",
    category: "Engineering",
    title: "Draft GitHub release notes in Notion",
    description:
      "Turn the PRs merged since the last release into clean notes in Notion.",
    shortDescription: "Turn merged PRs into release notes in Notion.",
    connectorSlugs: ["github", "notion", "slack"],
    behavior: [
      "A PR is labeled shipped",
      "Gather merged pull requests",
      "Release notes saved to Notion",
    ],
    missingInfo:
      "Connectors: github, notion required; slack optional.\nSuggested trigger: Add a github-pull-request event trigger with the labeled action on a release label, or a schedule trigger you run per release.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:feedback-router",
    category: "Product",
    title: "Feedback router",
    description:
      "Watch a Slack channel and route product feedback into Notion with labels and owners.",
    shortDescription: "Route product feedback from Slack into Notion.",
    connectorSlugs: ["slack", "notion"],
    behavior: [
      "Create a workflow that reviews messages from a selected Slack feedback channel.",
      "Classify feedback into themes, priority, sentiment, and affected product area.",
      "Create structured Notion records with links back to the source Slack messages.",
      "Optionally tag an owner or add follow-up notes based on the user's routing rules.",
    ],
    missingInfo:
      "Connectors: slack, notion required.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the Slack channel, Notion database, taxonomy, owner mapping, and run cadence.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:github-idea-to-notion-spec",
    category: "Product",
    title: "Turn a GitHub idea into a Notion spec",
    description:
      "Expand a labeled GitHub issue into a structured product spec in Notion.",
    shortDescription: "Expand a GitHub issue into a Notion spec.",
    connectorSlugs: ["github", "notion", "figma"],
    behavior: [
      "An issue is labeled needs-spec",
      "Expand it into a PRD",
      "Saved to Notion",
    ],
    missingInfo:
      "Connectors: github, notion required; figma optional.\nSuggested trigger: Add a github-pull-request event trigger with the labeled action on the needs-spec label.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:post-release-notes-slack",
    category: "Product",
    title: "Post release notes to Slack",
    description:
      "Draft a changelog from recently shipped work and post it to Slack.",
    shortDescription: "Draft a changelog and post it to Slack.",
    connectorSlugs: ["github", "slack", "notion"],
    behavior: [
      "A PR is labeled release",
      "Draft the changelog",
      "Posted to Slack and Notion",
    ],
    missingInfo:
      "Connectors: github, slack required; notion optional.\nSuggested trigger: Add a github-pull-request event trigger with the labeled action on the release label.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:sync-linear-roadmap-notion",
    category: "Product",
    title: "Sync the Linear roadmap to Notion",
    description: "Keep a Notion roadmap in sync with your Linear issue status.",
    shortDescription: "Keep a Notion roadmap in sync with Linear.",
    connectorSlugs: ["linear", "notion"],
    behavior: [
      "Read Linear status",
      "Mapped to Now / Next / Later",
      "Board updated in Notion",
    ],
    missingInfo:
      "Connectors: linear, notion required.\nSuggested trigger: Add a schedule trigger (e.g. daily). Linear has no native event trigger here, so poll on a cadence.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:track-feature-usage-posthog",
    category: "Product",
    title: "Track feature usage with PostHog",
    description:
      "Surface the biggest weekly shifts in feature usage from PostHog.",
    shortDescription: "Surface the week's biggest usage shifts.",
    connectorSlugs: ["posthog", "slack"],
    behavior: [
      "Read PostHog",
      "Compared week over week",
      "Shifts posted to Slack",
    ],
    missingInfo:
      "Connectors: posthog required; slack optional.\nSuggested trigger: Add a schedule trigger (e.g. weekly). PostHog has no native event trigger, so poll on a cadence.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:flag-figma-designs-no-task",
    category: "Product",
    title: "Flag Figma designs without a task",
    description: "Flag Figma designs that have no linked Linear task yet.",
    shortDescription: "Flag Figma designs with no Linear task.",
    connectorSlugs: ["figma", "linear", "slack"],
    behavior: [
      "Scan Figma frames",
      "Finds frames without a task",
      "Gaps posted to Slack",
    ],
    missingInfo:
      "Connectors: figma required; linear, slack optional.\nSuggested trigger: Add a schedule trigger (e.g. daily). Figma has no native event trigger, so poll on a cadence.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:check-posthog-signup-funnel",
    category: "Data",
    title: "Check the PostHog signup funnel",
    description:
      "Track the signup funnel and post the biggest drop-off to Slack.",
    shortDescription: "Post the signup funnel's biggest drop-off.",
    connectorSlugs: ["posthog", "slack"],
    behavior: [
      "Run the funnel",
      "Biggest drop-off identified",
      "Posted to Slack",
    ],
    missingInfo:
      "Connectors: posthog required; slack optional.\nSuggested trigger: Add a schedule trigger (e.g. weekly).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:x-brand-monitor",
    category: "Marketing",
    title: "X brand monitor",
    description:
      "Track brand mentions on X, save relevant posts in Notion, and alert Slack on high-signal mentions.",
    shortDescription: "Alert Slack on strong brand mentions on X.",
    connectorSlugs: ["x", "notion", "slack"],
    behavior: [
      "Create a scheduled workflow that searches X for product, company, or keyword mentions.",
      "Filter posts for relevance, engagement, sentiment, and response urgency.",
      "Save notable mentions to a Notion database with source links and suggested follow-up.",
      "Send Slack alerts for high-engagement, urgent, or reputationally sensitive posts.",
    ],
    missingInfo:
      "Connectors: x, notion required; slack optional.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the keywords or accounts, cadence, Notion database, Slack channel, and alert thresholds.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:draft-newsletter-mailchimp",
    category: "Marketing",
    title: "Draft the newsletter in Mailchimp",
    description:
      "Assemble recent updates into a newsletter draft in Mailchimp.",
    shortDescription: "Assemble recent updates into a newsletter.",
    connectorSlugs: ["github", "mailchimp"],
    behavior: [
      "Gather what shipped",
      "Newsletter drafted",
      "Staged in Mailchimp",
    ],
    missingInfo:
      "Connectors: github, mailchimp required.\nSuggested trigger: Add a schedule trigger (e.g. monthly).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:compare-google-ads-last-month",
    category: "Marketing",
    title: "Compare Google Ads vs last month",
    description:
      "Compare ad spend and ROAS to last month and flag anomalies in Slack.",
    shortDescription: "Compare ad spend and ROAS to last month.",
    connectorSlugs: ["google-ads", "slack", "meta-ads"],
    behavior: [
      "Read ad performance",
      "Compared to prior period",
      "Anomalies flagged in Slack",
    ],
    missingInfo:
      "Connectors: google-ads, slack required; meta-ads optional.\nSuggested trigger: Add a schedule trigger (e.g. every morning).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:support-ticket-router",
    category: "Support",
    title: "Support ticket router",
    description:
      "Classify support emails, create Notion records, and alert Slack for critical tickets.",
    shortDescription: "Classify support email and flag critical ones.",
    connectorSlugs: ["gmail", "notion", "slack"],
    behavior: [
      "Create a workflow that runs from a Gmail trigger or scheduled inbox scan.",
      "Classify support messages by category, priority, customer, and requested action.",
      "Create or update structured Notion records for each qualifying ticket.",
      "Alert Slack when a ticket is urgent, blocked, or needs human follow-up.",
    ],
    missingInfo:
      "Connectors: gmail, notion required; slack optional.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the inbox or label, triage rules, Notion database, Slack channel, and escalation criteria.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:send-bugs-github-slack",
    category: "Support",
    title: "Send bugs to GitHub and Slack",
    description:
      "File bug-tagged reports as GitHub issues and alert the team on Slack.",
    shortDescription: "File bug reports as GitHub issues.",
    connectorSlugs: ["github", "slack", "linear"],
    behavior: [
      "An issue is labeled bug",
      "Repro and impact packaged",
      "Sent to engineering",
    ],
    missingInfo:
      "Connectors: github, slack required; linear optional.\nSuggested trigger: Add a github-pull-request event trigger with the labeled action on the bug label.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:highlight-key-emails-gmail",
    category: "CEO",
    title: "Highlight key emails in Gmail",
    description: "Surface the few emails that actually need your attention.",
    shortDescription: "Surface the emails that need your attention.",
    connectorSlugs: ["gmail", "slack"],
    behavior: ["Read the inbox", "Priorities identified", "Posted to Slack"],
    missingInfo:
      "Connectors: gmail, slack required.\nSuggested trigger: Add a gmail-new-message event trigger, or a schedule trigger that runs a few times a day.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:investor-update-google-docs",
    category: "CEO",
    title: "Draft the investor update in Google Docs",
    description:
      "Assemble metrics and highlights into an investor update in Docs.",
    shortDescription: "Assemble metrics into an investor update.",
    connectorSlugs: ["stripe", "google-docs", "google-sheets"],
    behavior: ["Gather KPIs", "Update drafted", "Editable in Google Docs"],
    missingInfo:
      "Connectors: stripe, google-docs required; google-sheets optional.\nSuggested trigger: Add a schedule trigger (e.g. monthly).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:gmail-reconnect-reminders",
    category: "CEO",
    title: "Get Gmail reconnect reminders",
    description: "Surface important contacts you haven't emailed in a while.",
    shortDescription: "Surface contacts you haven't emailed lately.",
    connectorSlugs: ["gmail", "google-calendar", "slack"],
    behavior: [
      "Review the user's contacts",
      "Quiet relationships surfaced",
      "Openers suggested",
    ],
    missingInfo:
      "Connectors: gmail required; google-calendar, slack optional.\nSuggested trigger: Add a schedule trigger (e.g. weekly).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:sync-asana-projects-notion",
    category: "Operations",
    title: "Sync Asana projects to Notion",
    description: "Roll up Asana project status into a single board in Notion.",
    shortDescription: "Roll up Asana project status into Notion.",
    connectorSlugs: ["asana", "notion"],
    behavior: ["Read Asana", "Rolled into one board", "Digest posted"],
    missingInfo:
      "Connectors: asana, notion required.\nSuggested trigger: Add a schedule trigger (e.g. every morning). Asana has no native event trigger, so poll on a cadence.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:file-gmail-invoices-drive",
    category: "Operations",
    title: "File Gmail invoices to Google Drive",
    description: "File invoice emails to Drive and log each one in a Sheet.",
    shortDescription: "File invoice emails to Drive and log them.",
    connectorSlugs: ["gmail", "google-drive", "google-sheets"],
    behavior: [
      "An invoice is labeled",
      "Filed to Google Drive",
      "Logged in a sheet",
    ],
    missingInfo:
      "Connectors: gmail, google-drive required; google-sheets optional.\nSuggested trigger: Add a gmail-label-applied event trigger on the label you use for invoices.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:onboard-new-hires-asana",
    category: "Operations",
    title: "Onboard new hires in Asana",
    description:
      "Create the onboarding task checklist for each new hire in Asana.",
    shortDescription: "Create an onboarding checklist per new hire.",
    connectorSlugs: ["deel", "asana", "google-drive"],
    behavior: [
      "A new hire is added",
      "Checklist created in Asana",
      "Docs provisioned",
    ],
    missingInfo:
      "Connectors: deel, asana required; google-drive optional.\nSuggested trigger: Add a schedule trigger (e.g. daily). Deel has no native event trigger, so poll for new hires.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:chase-overdue-asana-tasks",
    category: "Operations",
    title: "Chase overdue Asana tasks",
    description: "Find overdue Asana tasks and nudge their owners on Slack.",
    shortDescription: "Nudge the owners of overdue Asana tasks.",
    connectorSlugs: ["asana", "slack"],
    behavior: ["Scan Asana", "Owners identified", "Nudges sent in Slack"],
    missingInfo:
      "Connectors: asana, slack required.\nSuggested trigger: Add a schedule trigger (e.g. every morning).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:catch-calendar-conflicts",
    category: "Operations",
    title: "Catch Google Calendar conflicts",
    description: "Scan your calendar for double-bookings and alert you early.",
    shortDescription: "Catch double-bookings in your calendar early.",
    connectorSlugs: ["google-calendar", "cal-com", "slack"],
    behavior: [
      "An event is created",
      "Checked for conflicts",
      "Conflict flagged in Slack",
    ],
    missingInfo:
      "Connectors: google-calendar required; cal-com, slack optional.\nSuggested trigger: Add a google-calendar-event-created event trigger, or a morning schedule that scans the day for conflicts.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:personal-weekly-digest",
    category: "Everyone",
    title: "Personal weekly digest",
    description:
      "Summarize GitHub, Gmail, and Calendar activity into one weekly Slack update.",
    shortDescription: "Summarize your week across GitHub and Gmail.",
    connectorSlugs: ["github", "gmail", "google-calendar", "slack"],
    behavior: [
      "Create a weekly scheduled workflow for the selected owner.",
      "Collect recent pull requests, important inbox threads, and upcoming or completed calendar events.",
      "Group the digest into accomplishments, pending decisions, follow-ups, and upcoming commitments.",
      "Send the digest to the user's chosen Slack destination.",
    ],
    missingInfo:
      "Connectors: slack required; github, gmail, google-calendar optional.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the day/time, timezone, GitHub scope, Gmail filters, calendar scope, and Slack destination.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:morning-brief",
    category: "Everyone",
    title: "Morning brief",
    description:
      "Turn Gmail, Calendar, and Notion updates into a short daily plan in Slack.",
    shortDescription: "Turn mail and meetings into a short daily plan.",
    connectorSlugs: ["gmail", "google-calendar", "notion", "slack"],
    behavior: [
      "Create a daily scheduled workflow that prepares a morning planning brief.",
      "Review important email, calendar events, and relevant Notion updates.",
      "Prioritize the day into meetings, decisions, follow-ups, and focus blocks.",
      "Post the brief to Slack or another destination the user chooses.",
    ],
    missingInfo:
      "Connectors: gmail, google-calendar, slack required; notion optional.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the schedule, timezone, Slack destination, Gmail scope, calendar scope, and Notion sources.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:sort-gmail-draft-replies",
    category: "Everyone",
    title: "Sort Gmail and draft replies",
    description:
      "Sort your inbox and draft replies to the emails that need them.",
    shortDescription: "Sort your inbox and draft the replies needed.",
    connectorSlugs: ["gmail"],
    behavior: ["Read new mail", "Sorted by urgency", "Replies drafted"],
    missingInfo:
      "Connectors: gmail required.\nSuggested trigger: Add a gmail-new-message event trigger so it runs on each new incoming email.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:summarize-gmail-newsletters",
    category: "Everyone",
    title: "Summarize Gmail newsletters",
    description: "Digest the newsletters in your inbox into one short summary.",
    shortDescription: "Digest your newsletters into one summary.",
    connectorSlugs: ["gmail", "slack"],
    behavior: [
      "Collect newsletters",
      "Digested into one summary",
      "Posted to Slack",
    ],
    missingInfo:
      "Connectors: gmail, slack required.\nSuggested trigger: Add a schedule trigger (e.g. weekly) to digest the newsletters, or a gmail-label-applied trigger on your newsletter label.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:flagged-gmail-todoist-tasks",
    category: "Everyone",
    title: "Turn flagged Gmail into Todoist tasks",
    description: "Turn the emails you flag into Todoist tasks automatically.",
    shortDescription: "Turn flagged emails into Todoist tasks.",
    connectorSlugs: ["gmail", "todoist"],
    behavior: ["You flag an email", "Research it", "Task filed in Todoist"],
    missingInfo:
      "Connectors: gmail, todoist required.\nSuggested trigger: Add a gmail-label-applied event trigger on the label you apply to flag an email.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
];

export function findWorkflowTemplateItem(
  id: string,
): WorkflowTemplateItem | undefined {
  return WORKFLOW_TEMPLATE_ITEMS.find((item) => {
    return item.id === id;
  });
}
