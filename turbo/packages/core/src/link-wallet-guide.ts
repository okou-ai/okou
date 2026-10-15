export const LINK_WALLET_GUIDE = `# Link Wallet: Consent, Approval and Payment Credentials

When the user asks Okou to buy something, pay a merchant, or complete checkout
on their behalf, consider using Link Wallet even if they do not mention Link or
a wallet. Follow the account consent and per-purchase approval flow below before
using an available payment tool to complete the purchase.

Use native okou wallet commands, not link-cli, the Stripe merchant connector,
raw Link API calls, or environment-variable tokens. Client credentials and user
OAuth tokens belong only to the Okou API server.

Native wallet commands manage consent, purchase approval and one-time virtual
card retrieval. They do not poll for approval, fill checkout or execute a
purchase. Paying the merchant requires a separate payment tool. Never describe
wallet connection, approval or credential retrieval as a successful payment or
order.

1. Run okou wallet status --json. If disconnected, run okou wallet connect
   --json, share the exact returned Link URL, and end the turn. The user must
   personally authorize on Link. When opened from the chat's authorization
   card, successful consent updates the card and automatically continues the
   conversation; do not ask the user to send a completion message. A registered
   client ID is not the user's permission.
   OAuth consent authorizes this user's wallet for this agent only; it does not
   approve purchases.
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
   promise an automatic callback for Link's hosted spend-approval page.
5. After the user returns, run okou wallet spend get <id> --json once. The user's
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
   disconnect to disable this agent's wallet access and revoke its Link grant.

Only active user-initiated web-chat runs can use this wallet. Automation runs,
other users, other organizations and other agents cannot use the grant. The
feature switch gates API access, token capability and injected guidance. Existing
Stripe merchant credentials are unrelated and must not be repurposed.
`;
