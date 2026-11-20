# Chat capability mail

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-mail.test.tsx](chat-capability-mail.test.tsx).

## chat-capability-mail-001

Original test `reconnecting the exact Gmail account required by a persisted mail card > reconnecting opens mail from the same required account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-mail.test.tsx#L278).

- **Given** A persisted mail card requires reconnecting the Gmail account sender@example.com, while a different Gmail account is already connected.
- **When** The user starts reconnecting, completes OAuth for the required account, and opens the card after reconnection.
- **Then** Reconnect is initiated for the required account, the card indicates that reconnection is in progress, and after completion the email details open with the subject and message body.

## chat-capability-mail-002

Original test `Inline, table, and nested mail links keep their labels and open email details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-mail.test.tsx#L317).

- **Given** A chat response includes trusted mail URLs as standalone cards, inline and bold links, table entries, list and quote links, bare URLs, relative URLs, and a URL before Chinese punctuation. It also includes a code-formatted URL and a link to an untrusted host.
- **When** The user opens each trusted mail link and clicks the untrusted link.
- **Then** Trusted links retain their displayed labels and open the matching email details without leaving the chat route; the inline link is not duplicated as a mail card. The untrusted link navigates normally and does not open email details; the code-formatted URL is not asserted as a link.

## chat-capability-mail-003

Original test `Send, revisit, and delete mail drafts from chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-mail.test.tsx#L480).

- **Given** Chat contains two Gmail draft cards, “Launch approval” and “Vendor follow-up.”
- **When** The user sends the first draft, revisits both cards, then deletes the second draft.
- **Then** The first draft is shown as sent with an Open in Gmail link to its sent thread. The second remains a draft until deleted; afterward its card and details close, while the first sent card remains.

## chat-capability-mail-004

Original test `An accepted Outlook send appears as sent immediately in chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-mail.test.tsx#L583).

- **Given** Chat contains an Outlook draft with a known Outlook web link, and the send request has not yet received confirmation.
- **When** The user sends the draft, then the send is accepted.
- **Then** While awaiting acceptance, Send is disabled and Sent is not shown. After acceptance, Sent appears in the email details and chat card, and the Send action is gone.

## chat-capability-mail-005

Original test `Open a trusted email card with safe, complete details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-mail.test.tsx#L636).

- **Given** A sent Gmail card contains complete sender, recipient, cc, bcc, HTML body, inline image, remote image, unsafe HTML, and PDF and text attachments.
- **When** The user opens the card and previews each attachment.
- **Then** Email details show the subject, sender, recipients, safe formatted body, inline image, remote image with no referrer, and a Gmail thread link; PDF and text previews display their content. Unsafe scripts, frames, inputs, executable links, and images are not rendered, private-token text is absent, and no script executes.

## chat-capability-mail-006

Original test `Deleting an earlier mail draft preserves the currently open mail`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-mail.test.tsx#L793).

- **Given** Two Gmail draft cards are available, and the first draft's deletion request is still pending.
- **When** The user starts deleting the first draft, opens the second email, and then the deletion completes.
- **Then** The first card disappears, while the second email remains open with its subject and message body visible.
