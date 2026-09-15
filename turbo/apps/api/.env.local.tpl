# Required: Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres

# Required: Authentication (Clerk)
CLERK_SECRET_KEY=op://Development/clerk/CLERK_SECRET_KEY
CLERK_PUBLISHABLE_KEY=op://Development/clerk/CLERK_PUBLISHABLE_KEY
CLERK_WEBHOOK_SIGNING_SECRET=op://Development/clerk/CLERK_WEBHOOK_SIGNING_SECRET

# Required: API, web, and app URLs
OKOU_API_BACKEND_URL=https://api.vm7.ai:8443
FEISHU_CALLBACK_BASE_URL=https://api.vm7.ai:8443
OKOU_WEB_URL=https://www.vm7.ai:8443
APP_URL=https://app.vm7.ai:8443

# CLI_PKG_URL is appended by scripts/sync-env.sh using the local machine identity.

# Optional: Atom redeem service for onboarding codes
ATOM_URL=https://atom-api.vm7.ai:8442
OKOU_MACHINE_SECRET_KEY=op://Development/clerk/OKOU_MACHINE_SECRET_KEY

# Required: API deploy stage tag
ENV=development

# Required: git commit SHA used as OTel service.version and Sentry release
GIT_COMMIT_SHA=local-dev

# Optional: Sandbox Runtime (Vercel Sandbox access-token auth)
VERCEL_TEAM_ID=op://Development/vercel/VERCEL_TEAM_ID
VERCEL_PROJECT_ID_API=op://Development/vercel/VERCEL_PROJECT_ID_API
VERCEL_TOKEN=op://Development/vercel/VERCEL_TOKEN

# Required: Object Storage (Cloudflare R2)
CF_ACCOUNT_ID=op://Development/cloudflare/CF_ACCOUNT_ID
CLOUDFLARE_BROWSER_RENDERING_API_TOKEN=op://Development/cloudflare/CLOUDFLARE_BROWSER_RENDERING_API_TOKEN
ARTIFACT_PREVIEW_WAF_SECRET=op://Development/cloudflare/ARTIFACT_PREVIEW_WAF_SECRET
R2_ACCOUNT_ID=op://Development/cloudflare/R2_ACCOUNT_ID
R2_ACCESS_KEY_ID=op://Development/cloudflare/R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=op://Development/cloudflare/R2_SECRET_ACCESS_KEY
R2_USER_STORAGES_BUCKET_NAME=op://Development/cloudflare/R2_USER_STORAGES_BUCKET_NAME
# Configure scoped private-bucket credentials before enabling privateArtifacts.
R2_PRIVATE_ARTIFACTS_BUCKET_NAME=user-artifact-private-dev
R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID=
R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY=
R2_USER_ARTIFACTS_BUCKET_NAME=user-artifact-dev
R2_USER_ARTIFACTS_ACCESS_KEY_ID=op://Development/cloudflare/R2_USER_ARTIFACTS_ACCESS_KEY_ID
R2_USER_ARTIFACTS_SECRET_ACCESS_KEY=op://Development/cloudflare/R2_USER_ARTIFACTS_SECRET_ACCESS_KEY
PUBLIC_ARTIFACTS_BASE_URL=https://cdn.vm7.io
OKOU_PUBLIC_ARTIFACTS_BASE_URL=https://cdn.vm7.io
PUBLIC_ARTIFACT_SHARES_BASE_URL=https://files.sites.vm7.io

# Optional: Hosted static sites (use a separate R2 token scoped to this bucket)
R2_HOSTED_SITES_BUCKET_NAME=op://Development/cloudflare/R2_HOSTED_SITES_BUCKET_NAME
R2_HOSTED_SITES_ACCESS_KEY_ID=op://Development/cloudflare/R2_HOSTED_SITES_ACCESS_KEY_ID
R2_HOSTED_SITES_SECRET_ACCESS_KEY=op://Development/cloudflare/R2_HOSTED_SITES_SECRET_ACCESS_KEY
OKOU_PUBLIC_HOST_DOMAIN=sites.vm7.io
OKOU_HOST_SCHEME=https

# Optional: Realtime (Ably)
ABLY_API_KEY=op://Development/ably/ABLY_API_KEY

# Required: Observability (Axiom)
AXIOM_TOKEN_SESSIONS=op://Development/axiom/AXIOM_TOKEN_SESSIONS
AXIOM_TOKEN_TELEMETRY=op://Development/axiom/AXIOM_TOKEN_TELEMETRY
AXIOM_DATASET_SUFFIX=dev

# Optional: isolated Pi Langfuse project. Tracing starts only for runs whose
# user has explicitly enabled the default-off feature switch.
LANGFUSE_PUBLIC_KEY=op://Development/langfuse/LANGFUSE_PUBLIC_KEY
LANGFUSE_SECRET_KEY=op://Development/langfuse/LANGFUSE_SECRET_KEY
LANGFUSE_BASE_URL=https://us.cloud.langfuse.com

# Required: Secrets encryption
SECRETS_ENCRYPTION_KEY=op://Development/vm0/SECRETS_ENCRYPTION_KEY

# Optional: AWS KMS stored-secret encryption for local/test dual-write
SECRETS_KMS_KEY_ID=op://Development/aws-kms/SECRETS_KMS_KEY_ID
AWS_REGION=op://Development/aws-kms/AWS_REGION
AWS_ACCESS_KEY_ID=op://Development/aws-kms/AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=op://Development/aws-kms/AWS_SECRET_ACCESS_KEY

# Optional: Slack Integration
SLACK_OAUTH_CLIENT_ID=op://Development/slack/SLACK_OAUTH_CLIENT_ID
SLACK_OAUTH_CLIENT_SECRET=op://Development/slack/SLACK_OAUTH_CLIENT_SECRET
SLACK_SIGNING_SECRET=op://Development/slack/SLACK_SIGNING_SECRET

# Optional: Official Telegram Bot
TELEGRAM_OFFICIAL_BOT_TOKEN=op://Development/telegram/TELEGRAM_OFFICIAL_BOT_TOKEN
TELEGRAM_OFFICIAL_BOT_USERNAME=op://Development/telegram/TELEGRAM_OFFICIAL_BOT_USERNAME
TELEGRAM_OFFICIAL_WEBHOOK_SECRET=op://Development/telegram/TELEGRAM_OFFICIAL_WEBHOOK_SECRET

# Required: Claude Code Version URL
CLAUDE_CODE_VERSION_URL=https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest

# Required: OpenAI (voice-chat ephemeral token minting, STT, TTS)
OPENAI_API_KEY=op://Development/openai/OPENAI_API_KEY

# Optional: OpenRouter lightweight model calls
OPENROUTER_API_KEY=op://Development/openrouter/Section_ak7dvythmldarvk4dodjs4ecyq/OPENROUTER_API_KEY

# Google LLM workload identity (Vercel preview uses llm-dev; no static key).
# Configure all three together; runtime OIDC is supplied by Vercel.
GCP_LLM_PROJECT_ID=
GCP_LLM_WORKLOAD_IDENTITY_PROVIDER=
GCP_LLM_SERVICE_ACCOUNT_EMAIL=

# Required: OpenAI Webhook signing secret (for built-in generations webhook)
OPENAI_WEBHOOK_SECRET=op://Development/openai/OPENAI_WEBHOOK_SECRET

# Optional: fal media generation
FAL_KEY=op://Development/fal/FAL_KEY

# Optional: JoggAI talking-avatar video generation
JOGGAI_API_KEY=op://Development/joggai/JOGGAI_API_KEY
JOGGAI_WEBHOOK_SECRET=op://Development/joggai/JOGGAI_WEBHOOK_SECRET

# Optional: HeyGen Intro Video avatar rendering
HEYGEN_API_KEY=op://Development/heygen/HEYGEN_API_KEY

# Optional: BytePlus ModelArk video generation
BYTEPLUS_API_KEY=op://Development/byteplus/BYTEPLUS_API_KEY

# Optional: BytePlus voice input STT
BYTEPLUS_STT_API_KEY=op://Development/byteplus/BYTEPLUS_STT_API_KEY

# Optional: Airtable OAuth Connector
AIRTABLE_OAUTH_CLIENT_ID=op://Development/airtable/AIRTABLE_OAUTH_CLIENT_ID
AIRTABLE_OAUTH_CLIENT_SECRET=op://Development/airtable/AIRTABLE_OAUTH_CLIENT_SECRET

# Optional: GitHub OAuth Connector
GH_OAUTH_CLIENT_ID=op://Development/github/GH_OAUTH_CLIENT_ID
GH_OAUTH_CLIENT_SECRET=op://Development/github/GH_OAUTH_CLIENT_SECRET

# Optional: Cloudflare OAuth Connector
CLOUDFLARE_OAUTH_CLIENT_ID=op://Development/cloudflare/CLOUDFLARE_OAUTH_CLIENT_ID
CLOUDFLARE_OAUTH_CLIENT_SECRET=op://Development/cloudflare/CLOUDFLARE_OAUTH_CLIENT_SECRET

# Optional: Notion OAuth Connector
NOTION_OAUTH_CLIENT_ID=op://Development/notion/NOTION_OAUTH_CLIENT_ID
NOTION_OAUTH_CLIENT_SECRET=op://Development/notion/NOTION_OAUTH_CLIENT_SECRET

# Optional: Google OAuth Connector (Gmail, Calendar, Drive, etc.)
GOOGLE_OAUTH_CLIENT_ID=op://Development/google/GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET=op://Development/google/GOOGLE_OAUTH_CLIENT_SECRET

# Optional: Gmail Pub/Sub mailbox event automation
GMAIL_PUBSUB_TOPIC_NAME=op://Development/gmail/GMAIL_PUBSUB_TOPIC_NAME
GMAIL_PUBSUB_PUSH_AUDIENCE=op://Development/gmail/GMAIL_PUBSUB_PUSH_AUDIENCE
GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL=op://Development/gmail/GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL

# Optional: Google Ads API (developer token + login customer ID for MCC)
GOOGLE_ADS_DEVELOPER_TOKEN=op://Development/google/GOOGLE_ADS_DEVELOPER_TOKEN
GOOGLE_ADS_LOGIN_CUSTOMER_ID=op://Development/google/GOOGLE_ADS_LOGIN_CUSTOMER_ID

# Optional: Google Maps API
OKOU_MAPS_GOOGLE_MAPS_TOKEN=op://Development/google/OKOU_MAPS_GOOGLE_MAPS_TOKEN

# Optional: Google Weather and Air Quality APIs
OKOU_WEATHER_GOOGLE_WEATHER_TOKEN=op://Development/google/OKOU_WEATHER_GOOGLE_WEATHER_TOKEN

# Optional: Okou Scrape provider (Firecrawl)
OKOU_SCRAPE_FIRECRAWL_TOKEN=op://Development/Firecrawl/FIRECRAWL_API_TOKEN

# Optional: Okou Web Search provider (Perplexity)
OKOU_WEB_SEARCH_PERPLEXITY_TOKEN=op://Development/Perplexity/PERPLEXITY_API_TOKEN

# Optional: Okou Finance provider (APIDojo via RapidAPI)
# 1Password: Development vault > APIDojo item > RAPIDAPI_KEY concealed field
OKOU_FINANCE_APIDOJO_TOKEN=op://Development/APIDojo/RAPIDAPI_KEY

# Optional: Okou SEO provider (DataForSEO)
OKOU_SEO_DATAFORSEO_LOGIN=op://Development/DataForSEO/LOGIN
OKOU_SEO_DATAFORSEO_PASSWORD=op://Development/DataForSEO/PASSWORD

# Optional: Managed browser provider (Browser Use)
OKOU_BROWSER_USE_API_KEY=op://Development/browser-use/OKOU_BROWSER_USE_API_KEY

# Optional: Steam Web API
STEAM_WEB_API_KEY=op://Development/steam/STEAM_WEB_API_KEY

# Optional: Finicity Open Banking
FINICITY_APP_KEY=op://Development/finicity/FINICITY_APP_KEY
FINICITY_APP_SECRET=op://Development/finicity/FINICITY_APP_SECRET
FINICITY_PARTNER_ID=op://Development/finicity/FINICITY_PARTNER_ID

# Optional: Microsoft OAuth Connector (Outlook Calendar, etc.)
MICROSOFT_OAUTH_CLIENT_ID=op://Development/microsoft/MICROSOFT_OAUTH_CLIENT_ID
MICROSOFT_OAUTH_CLIENT_SECRET=op://Development/microsoft/MICROSOFT_OAUTH_CLIENT_SECRET

# Optional: Microsoft Teams Bot
MICROSOFT_TEAMS_BOT_APP_ID=op://Development/microsoft/MICROSOFT_TEAMS_BOT_APP_ID
MICROSOFT_TEAMS_BOT_APP_PASSWORD=op://Development/microsoft/MICROSOFT_TEAMS_BOT_APP_PASSWORD
MICROSOFT_TEAMS_APP_TENANT_ID=op://Development/microsoft/MICROSOFT_TEAMS_APP_TENANT_ID

# Optional: HubSpot OAuth Connector
HUBSPOT_OAUTH_CLIENT_ID=op://Development/hubspot/HUBSPOT_OAUTH_CLIENT_ID
HUBSPOT_OAUTH_CLIENT_SECRET=op://Development/hubspot/HUBSPOT_OAUTH_CLIENT_SECRET

# Optional: Close OAuth Connector
CLOSE_OAUTH_CLIENT_ID=op://Development/close/CLOSE_OAUTH_CLIENT_ID
CLOSE_OAUTH_CLIENT_SECRET=op://Development/close/CLOSE_OAUTH_CLIENT_SECRET

# Optional: Deel OAuth Connector
DEEL_OAUTH_CLIENT_ID=op://Development/deel/DEEL_OAUTH_CLIENT_ID
DEEL_OAUTH_CLIENT_SECRET=op://Development/deel/DEEL_OAUTH_CLIENT_SECRET

# Optional: DocuSign OAuth Connector
DOCUSIGN_OAUTH_CLIENT_ID=op://Development/docusign/DOCUSIGN_OAUTH_CLIENT_ID
DOCUSIGN_OAUTH_CLIENT_SECRET=op://Development/docusign/DOCUSIGN_OAUTH_CLIENT_SECRET

# Optional: Dropbox OAuth Connector
DROPBOX_OAUTH_CLIENT_ID=op://Development/dropbox/DROPBOX_OAUTH_CLIENT_ID
DROPBOX_OAUTH_CLIENT_SECRET=op://Development/dropbox/DROPBOX_OAUTH_CLIENT_SECRET

# Optional: Linear OAuth Connector
LINEAR_OAUTH_CLIENT_ID=op://Development/linear/LINEAR_OAUTH_CLIENT_ID
LINEAR_OAUTH_CLIENT_SECRET=op://Development/linear/LINEAR_OAUTH_CLIENT_SECRET

# Optional: Figma OAuth Connector
FIGMA_OAUTH_CLIENT_ID=op://Development/figma/FIGMA_OAUTH_CLIENT_ID
FIGMA_OAUTH_CLIENT_SECRET=op://Development/figma/FIGMA_OAUTH_CLIENT_SECRET

# Optional: X OAuth Connector
X_OAUTH_CLIENT_ID=op://Development/x/X_OAUTH_CLIENT_ID
X_OAUTH_CLIENT_SECRET=op://Development/x/X_OAUTH_CLIENT_SECRET

# Optional: Vercel OAuth Connector
VERCEL_OAUTH_CLIENT_ID=op://Development/vercel/VERCEL_OAUTH_CLIENT_ID
VERCEL_OAUTH_CLIENT_SECRET=op://Development/vercel/VERCEL_OAUTH_CLIENT_SECRET
VERCEL_INTEGRATION_SLUG=op://Development/vercel/VERCEL_INTEGRATION_SLUG

# Optional: Sentry OAuth Connector
SENTRY_OAUTH_CLIENT_ID=op://Development/sentry/SENTRY_OAUTH_CLIENT_ID
SENTRY_OAUTH_CLIENT_SECRET=op://Development/sentry/SENTRY_OAUTH_CLIENT_SECRET

# Optional: Xero OAuth Connector
XERO_OAUTH_CLIENT_ID=op://Development/xero/XERO_OAUTH_CLIENT_ID
XERO_OAUTH_CLIENT_SECRET=op://Development/xero/XERO_OAUTH_CLIENT_SECRET

# Optional: Todoist OAuth Connector
TODOIST_OAUTH_CLIENT_ID=op://Development/todoist/TODOIST_OAUTH_CLIENT_ID
TODOIST_OAUTH_CLIENT_SECRET=op://Development/todoist/TODOIST_OAUTH_CLIENT_SECRET

# Optional: Monday.com OAuth Connector
MONDAY_OAUTH_CLIENT_ID=op://Development/monday/MONDAY_OAUTH_CLIENT_ID
MONDAY_OAUTH_CLIENT_SECRET=op://Development/monday/MONDAY_OAUTH_CLIENT_SECRET
MONDAY_OAUTH_APP_ID=op://Development/monday/MONDAY_OAUTH_APP_ID

# Optional: Wix OAuth Connector
WIX_OAUTH_CLIENT_ID=op://Development/wix/WIX_OAUTH_CLIENT_ID
WIX_OAUTH_CLIENT_SECRET=op://Development/wix/WIX_OAUTH_CLIENT_SECRET

# Optional: Meta Ads OAuth Connector
META_ADS_OAUTH_CLIENT_ID=op://Development/meta-ads/META_ADS_OAUTH_CLIENT_ID
META_ADS_OAUTH_CLIENT_SECRET=op://Development/meta-ads/META_ADS_OAUTH_CLIENT_SECRET

# Optional: Canva OAuth Connector
CANVA_OAUTH_CLIENT_ID=op://Development/canva/CANVA_OAUTH_CLIENT_ID
CANVA_OAUTH_CLIENT_SECRET=op://Development/canva/CANVA_OAUTH_CLIENT_SECRET

# Optional: Webflow OAuth Connector
WEBFLOW_OAUTH_CLIENT_ID=op://Development/webflow/WEBFLOW_OAUTH_CLIENT_ID
WEBFLOW_OAUTH_CLIENT_SECRET=op://Development/webflow/WEBFLOW_OAUTH_CLIENT_SECRET

# Optional: Stripe OAuth Connector
STRIPE_OAUTH_CLIENT_ID=op://Development/stripe/STRIPE_OAUTH_CLIENT_ID
STRIPE_OAUTH_CLIENT_SECRET=op://Development/stripe/STRIPE_OAUTH_CLIENT_SECRET

# Optional: Stripe Billing (Vercel AI Gateway metering)
STRIPE_VERCEL_GATEWAY_REPORT_ACCESS_KEY=op://Development/stripe/STRIPE_VERCEL_GATEWAY_REPORT_ACCESS_KEY

# Optional: Stripe Billing (subscription + credits)
STRIPE_SECRET_KEY=op://Development/stripe/STRIPE_SECRET_KEY
STRIPE_CONCURRENCY_PORTAL_CONFIGURATION_ID=op://Development/stripe/STRIPE_CONCURRENCY_PORTAL_CONFIGURATION_ID
STRIPE_WEBHOOK_SECRET=op://Development/stripe/STRIPE_WEBHOOK_SECRET
OKOU_PRICE_PRO=op://Development/stripe/OKOU_PRICE_PRO
OKOU_PRICE_TEAM=op://Development/stripe/OKOU_PRICE_TEAM
OKOU_PRICE_USAGE_PACK_PLAN_PRO=op://Development/stripe/OKOU_PRICE_USAGE_PACK_PLAN_PRO
OKOU_PRICE_USAGE_PACK_PLAN_TEAM=op://Development/stripe/OKOU_PRICE_USAGE_PACK_PLAN_TEAM
OKOU_PRICE_CUSTOM=op://Development/stripe/OKOU_PRICE_CUSTOM
OKOU_PRICE_USAGE_PACK_20=op://Development/stripe/OKOU_PRICE_USAGE_PACK_20
OKOU_PRICE_USAGE_PACK_50=op://Development/stripe/OKOU_PRICE_USAGE_PACK_50
OKOU_PRICE_USAGE_PACK_100=op://Development/stripe/OKOU_PRICE_USAGE_PACK_100
OKOU_PRICE_USAGE_PACK_200=op://Development/stripe/OKOU_PRICE_USAGE_PACK_200
ATOM_GRANT_PRICE=op://Development/stripe/ATOM_GRANT_PRICE
OKOU_PRICE_CUSTOM_CREDITS=op://Development/stripe/OKOU_PRICE_CUSTOM_CREDITS
OKOU_PRICE_CUSTOM_CREDIT_UNIT=op://Development/stripe/OKOU_PRICE_CUSTOM_CREDIT_UNIT
OKOU_PRICE_CONCURRENCY=op://Development/stripe/OKOU_PRICE_CONCURRENCY
OKOU_ONE_TIME_CAMPAIGN=op://Development/stripe/OKOU_ONE_TIME_CAMPAIGN

# Optional: AgentPhone (Phone/iMessage Channel)
AGENTPHONE_API_KEY=op://Development/agentphone/AGENTPHONE_API_KEY
AGENTPHONE_API_BASE_URL=https://api.agentphone.to
AGENTPHONE_AGENT_ID=op://Development/agentphone/AGENTPHONE_AGENT_ID
AGENTPHONE_PHONE_NUMBER=op://Development/agentphone/AGENTPHONE_PHONE_NUMBER
AGENTPHONE_WEBHOOK_SECRET=op://Development/agentphone/AGENTPHONE_WEBHOOK_SECRET

# Optional: ngrok (Computer Connector)
NGROK_API_KEY=op://Development/ngrok/NGROK_API_KEY
NGROK_COMPUTER_CONNECTOR_DOMAIN=computer.vm7.io

# Optional: Blog Configuration
BLOG_BASE_URL=
BLOG_DATA_SOURCE=strapi
STRAPI_URL=

# Optional: Error Tracking (Sentry)
SENTRY_DSN=

# Optional: Github App for Integration
GITHUB_APP_CLIENT_ID=op://Development/github/GITHUB_APP_CLIENT_ID
GITHUB_APP_CLIENT_SECRET=op://Development/github/GITHUB_APP_CLIENT_SECRET
GITHUB_APP_ID=op://Development/github/GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY=op://Development/github/GITHUB_APP_PRIVATE_KEY
GITHUB_APP_SLUG=op://Development/github/GITHUB_APP_SLUG
GITHUB_APP_WEBHOOK_SECRET=op://Development/github/GITHUB_APP_WEBHOOK_SECRET

# Optional: Built-in model provider API keys
DEV_MODEL_ANTHROPIC_KEY=op://Development/anthropic/DEV_MODEL_ANTHROPIC_KEY
DEV_MODEL_OPENAI_KEY=op://Development/openai/OPENAI_API_KEY
DEV_MODEL_MOONSHOT_KEY=op://Development/moonshot/DEV_MODEL_MOONSHOT_KEY
DEV_MODEL_ZAI_KEY=op://Development/z.ai/DEV_MODEL_ZAI_KEY
DEV_MODEL_MINIMAX_KEY=op://Development/minimax/DEV_MODEL_MINIMAX_KEY
DEV_MODEL_DEEPSEEK_KEY=op://Development/deepseek/DEEPSEEK_LOCAL_DEV_KEY

# Optional: Web Push (VAPID)
VAPID_PUBLIC_KEY=op://Development/vapid/VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY=op://Development/vapid/VAPID_PRIVATE_KEY

# Optional: Self-hosted Runner (for local development with runner on dev-1)
# RUNNER_DEFAULT_GROUP is auto-configured by sync-env.sh; do not add here.
OFFICIAL_RUNNER_SECRET=0000000000000000000000000000000000000000000000000000000000000000

# Required for the dev-only cron scheduler that emulates vercel.json crons in
# `pnpm dev`. A fixed local value is fine; production uses a Vercel-managed
# secret and never touches this file.
CRON_SECRET=local-dev-cron-secret
