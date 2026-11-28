# chat-events-connectors

## chat-events-connectors-001

- Vitest: "chat connector credential placeholders > keeps firewall-only credentials deferred during Run preparation"
- Mode: run
- Given: An entitled member has connected Figma and GitLab accounts used through the request firewall.
- When: The member sends a Fable prompt and the Runner claims the Run.
- Then: Run preparation makes no KMS decrypt calls. Dispatch includes a Figma placeholder and credential source metadata identifying the connected Figma account.

## chat-events-connectors-002

- Vitest: "chat connector credential placeholders > dispatches every connector secret as a placeholder and resolves values on demand"
- Mode: run
- Given: An entitled member has connected OpenAI and Figma accounts.
- When: The member sends a Fable prompt, then the Run's firewall client separately resolves OpenAI and Figma bearer headers.
- Then: Dispatch provides placeholders and OpenAI account metadata, excludes the raw OpenAI secret, and makes zero KMS decrypt calls before use. Each authorized firewall request returns HTTP 200 with the corresponding account credential.

## chat-events-connectors-003

- Vitest: "chat connector credential placeholders > isolates an undecryptable unselected account from request-time selected account auth"
- Mode: run
- Given: A member has OpenAI accounts with an undecryptable unselected account and a usable account selected for the thread.
- When: The member starts a Fable Run and its firewall client resolves the selected OpenAI header.
- Then: Preparation does not increase KMS decryption calls, dispatch binds the selected healthy account, and authorized resolution returns HTTP 200 and the healthy account bearer credential.

## chat-events-connectors-004

- Vitest: "CHAT-02: thread connector account selection > inspects and runs with the thread's selected builtin account"
- Mode: run
- Given: An entitled member has explicitly selected a built-in OpenAI account for a thread.
- When: The member reads the selection, inspects it through the account endpoint and sends a new prompt to the thread.
- Then: Both reads return HTTP 200. The exact selected account is reported available with the matching target, and its connection ID is the OpenAI credential source in the Runner dispatch.

## chat-events-connectors-005

- Vitest: "CHAT-02: thread connector account selection > with a thread with a selected connector > does not expose a disabled connector and resumes with it after enabling"
- Mode: run
- Given: An entitled member has an OpenAI account selected on a thread and can update its default Chat allowance.
- When: The member disables it, sends a prompt, reenables it and sends another.
- Then: The disabled dispatch omits the OpenAI credential reference. Reenabling makes the existing selected connection the credential source on the next dispatch.

## chat-events-connectors-006

- Vitest: "CHAT-02: thread connector account selection > uses the selected connector with the personal subscription model"
- Mode: run
- Given: A member owns a thread with a selected OpenAI account and a configured personal Claude Fable 5.1 subscription.
- When: The member sends a prompt and a Runner claims it.
- Then: The dispatch uses Fable for the Anthropic session and keeps the selected OpenAI connector account as its credential source.

## chat-events-connectors-007

- Vitest: "CHAT-02: thread connector account selection > uses the default connector account across revocation without an override"
- Mode: run
- Given: An entitled member has a default OpenAI account with no per-thread override.
- When: The member sends a prompt and completes it, revokes the account's default Chat allowance and continues the thread.
- Then: The first dispatch uses the default account without persisting a thread selection or emitting a thread-detail invalidation. The continuation while revoked omits that credential.

## chat-events-connectors-008

- Vitest: "CHAT-02: thread connector account selection > uses the default connector account across reauthorization without an override"
- Mode: run
- Given: An entitled member has a default OpenAI account and a thread without a selection override.
- When: The member disables the account's default Chat allowance, sends and completes a prompt, then enables it and sends again.
- Then: The disabled dispatch omits the OpenAI credential. After reauthorization the next dispatch uses the same account as its credential source.

## chat-events-connectors-009

- Vitest: "CHAT-02: thread connector account selection > uses default custom HTTP and MCP accounts without persisting overrides"
- Mode: run
- Given: An entitled member has authorized default accounts for custom HTTP and MCP connectors.
- When: The member starts a Chat Run, the Run's firewall client requests each connector's headers, and the member reads thread selections.
- Then: Dispatch contains the exact two custom runtime targets and matching inline firewall account IDs, with unknown HTTP permissions denied. Authorized header resolution returns HTTP 200 and the matching HTTP or MCP account secret. The selection read returns HTTP 200 with no stored overrides.

## chat-events-connectors-010

- Vitest: "CHAT-02: thread connector account selection > omits a custom connector whose current account cannot render the updated host template"
- Mode: run
- Given: A member has selected a custom connector account that cannot render a required tenant variable after its host template changes.
- When: The member changes the host template and sends a prompt on that thread.
- Then: The Run still dispatches, with an empty connector runtime target list and no firewall for that connector.

## chat-events-connectors-011

- Vitest: "CHAT-02: thread connector account selection > starts the run when a selected custom connector becomes unavailable"
- Mode: run
- Given: A member has an explicitly selected custom connector account whose connected status was visible on the thread.
- When: The member changes the connector to require a different credential absent on the account, then continues the same Chat.
- Then: A Run still dispatches, omitting the unavailable connector target. The HTTP 200 thread selection read retains the original stored connection and target.
