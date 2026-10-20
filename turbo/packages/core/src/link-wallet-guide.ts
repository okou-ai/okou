export const LINK_WALLET_GUIDE = `# Link Wallet: Consent, Approval and Payment Credentials

When the user asks Okou to buy something, pay a merchant, or complete checkout
on their behalf, consider using Link Wallet even if they do not mention Link or
a wallet. Follow the account consent and per-purchase approval flow below before
using an available payment tool to complete the purchase.

Use native okou wallet commands, not link-cli, the Stripe merchant connector,
raw Link API calls, or environment-variable tokens. Client credentials and user
OAuth tokens belong only to the Okou API server.

Native wallet commands read authorized wallet data and manage consent,
purchase approval and one-time virtual card retrieval. They do not poll for approval, fill checkout or execute a
purchase. Paying the merchant requires a separate payment tool. Never describe
wallet connection, approval or credential retrieval as a successful payment or
order.

## Read authorized wallet data

Use okou wallet status --json to inspect granted scopes, source actions and
available capabilities. Read commands require wallet:read (wallet:write also
permits reads); they never return payment credentials. The same user, workspace,
Agent and active web-run boundaries apply to reads.

- okou wallet spend list --start-date YYYY-MM-DD --end-date YYYY-MM-DD --limit 20 --json
  lists this user's recorded purchase requests for this Agent. Dates use UTC.
  These amounts are requested budgets, not settled spending. statusSource=recorded
  can be stale; use spend get only when canRefresh=true to obtain the latest
  payment outcome, failure and refund details. Reads never send approval
  requests; only retry the original spend create input and intent to resume
  incomplete setup for a purchase the user still authorizes. Old authorizations remain local
  history and never authorize another payment.
- okou wallet transactions list --origin link --start-date YYYY-MM-DD --end-date YYYY-MM-DD --json
  reads actual Link activity within the user's granted financial-data access.
  Follow nextCursor with --starting-after until hasMore=false before reporting
  complete totals. A null hasMore means Link did not report completeness;
  follow an available nextCursor and retain that uncertainty. Keep currencies separate and distinguish refunds and payment
  states. Empty or incomplete results do not establish zero spending. External
  bank/card transactions are not supported by these commands.
- okou wallet payment-methods list/get reads saved-method metadata and card tail
  digits; it does not retrieve a reusable card or authorize a purchase.
- okou wallet user-info get --json reads profile, spend limits and verification
  requirements. Missing values mean unavailable, not zero. Share any returned
  verification action URL exactly; the user must complete it personally.

Saved-method metadata requires payment_methods.agentic in Link.

Use okou wallet connect --json to request payment, profile and Link transaction
access together. It includes payment_methods.agentic, userinfo:read and the
read_link_transactions source action. Existing grants remain usable while
consent is pending or declined; completed reauthorization replaces the grant
and old purchase intents cannot be reused. Share the exact consent URL and end
the turn. Inspect granted access again after the callback; requesting a
permission does not mean it was granted. Each purchase still needs separate
approval. Existing read-only authorizations remain usable for permitted reads.

## Purchase approval

1. Run okou wallet status --json. If disconnected, run okou wallet connect
   --json, share the exact returned Link URL, and end the turn. The user must
   personally authorize on Link. When opened from the chat's authorization
   card, successful consent updates the card and automatically continues the
   conversation; do not ask the user to send a completion message. A registered
   client ID is not the user's permission.
   OAuth consent authorizes this user's wallet across agents in the current
   workspace; it does not approve purchases. The user can also manage the
   connection in Settings > Billing & pricing > Wallet.
2. Establish the specific item, merchant, final total including tax/shipping,
   USD currency, and the user's budget. Do not assume a budget or approve on the
   user's behalf. Generate one UUID purchase intent and retain it across retries.
3. Run okou wallet spend create --intent-id <uuid> --amount <integer cents>
   --currency usd --merchant-name <name> --merchant-url <https-url>
   --context <at least 100 characters describing the purchase and purpose>
   --json. Use --test for a no-funds request. This never authorizes a purchase
   programmatically; Link requests the user's approval.
4. Share the exact approvalUrl with a concise merchant/amount/item summary and
   end the turn. Do not open, click, or approve it on behalf of the user. Do not
   poll from the run. When the response has autoContinue=true, Okou watches this
   request for up to 30 minutes from creation and sends a continuation message
   to this same chat after approval. The user can continue manually sooner.
   If autoContinue is false, do not promise an automatic callback.
5. After the user returns or the approval continuation arrives, run okou wallet spend get <id> --json once. The user's
   message or a visited URL is not approval: rely on Link's actual request status.
   Pending means wait; denied/expired/canceled/failed means stop. For
   requires_action, show only its returned action URL and follow its resolution.
   Only auto_resume continues the same request; other resolutions need a new
   explicit approval after the issue is resolved. Never silently replace an
   uncertain payment with another intent or blindly retry a purchase.
6. Approved means permission, not payment. For nextAction=retrieve_credentials,
   run okou wallet spend credentials <id> --output-file <new-private-json-path>
   --json. This checks Link's current approval and writes the one-time card to a
   new file with mode 0600; stdout contains only its path and redacted summary.
   Use a temporary path outside the repository. Existing files are never
   overwritten. Optional CVC, billing address and validUntil are included only
   when Link supplies them; do not invent missing payment information.
   Pass the file directly to the payment tool. Never print, upload or paste its
   contents into chat, model context, transcripts or logs. Delete it after use.
   Never retrieve a card or token through an alternate tool or ask the user to
   paste PAN/CVC, passwords or tokens in chat. Recheck the merchant and final
   total before payment; use test credentials only with a test checkout.
   submitted is an uncertain/in-flight payment; succeeded still needs merchant
   order/receipt verification before claiming fulfillment. Never treat an
   approval or a saved credential file as a completed order.
7. An intent is immutable: changing amount, currency, merchant, context, mode,
   or wallet authorization must not reuse it. A changed purchase requires fresh
   user agreement and a new Link approval. Do not increase a budget silently.
8. Use okou wallet spend cancel <id> to cancel an unused request, and okou wallet
   disconnect to revoke this user's Link grant for all agents in this workspace.

Only active user-initiated web-chat runs can use this wallet. Automation runs,
other users and other organizations cannot use the grant. Purchase requests
remain tied to their originating agent and cannot be transferred. The
feature switch gates API access, token capability and injected guidance. Existing
Stripe merchant credentials are unrelated and must not be repurposed.
`;
