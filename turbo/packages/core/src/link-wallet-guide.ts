export const LINK_WALLET_GUIDE = `# Link Wallet: Hosted Consent and Approval

Use native okou wallet commands, not link-cli, the Stripe merchant connector,
raw Link API calls, or environment-variable tokens. Client credentials and user
OAuth tokens belong only to the Okou API server.

This first version prepares wallet consent and purchase approval only. It does
NOT retrieve a virtual card, expose payment tokens, fill checkout, or execute a
purchase. Before creating an approval-only request, explain this limitation and
obtain the user's agreement. Never describe wallet connection or approval as a
successful payment or order.

1. Run okou wallet status --json. If disconnected, run okou wallet connect
   --json, share the exact returned Link URL, and end the turn. The user must
   personally authorize on Link and return to the chat. A registered client ID
   is not the user's permission. OAuth consent authorizes this user's wallet
   for this agent only; it does not approve purchases.
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
6. Approved means permission, not payment. nextAction=secure_checkout_unavailable
   requires stopping and explaining that managed checkout is not implemented.
   Never retrieve a card or token through an alternate tool or ask the user to
   paste PAN/CVC, passwords or tokens in chat. submitted is an uncertain/in-flight
   payment; succeeded still needs merchant order/receipt verification before
   claiming fulfillment. Never treat an approval as a completed order.
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
