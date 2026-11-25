# agent-notification-email-renderer

## agent-notification-email-renderer-001

- Vitest: "pure agent notification email rendering > preserves non-default and nested list numbering in either notification purpose"
- Mode: run
- Intent: review
- Given: A regular agent notification includes ordered lists starting at 3 and 0 and a nested list starting at 5.
- When: The email is rendered as HTML and plain text.
- Then: The HTML ordered lists retain starts 3, 0 and 5 without falling back to preformatted text. The plain version preserves the numbers on the corresponding first items.

## agent-notification-email-renderer-002

- Vitest: "pure agent notification email rendering > preserves non-default and nested list numbering in either notification purpose"
- Mode: run
- Intent: review
- Given: A Morning Brief includes ordered lists starting at 3 and 0 and a nested list starting at 5.
- When: The email is rendered as HTML and plain text.
- Then: The HTML ordered lists retain starts 3, 0 and 5 without falling back to preformatted text. The plain version preserves the numbers on the corresponding first items.

## agent-notification-email-renderer-003

- Vitest: "pure agent notification email rendering > validates entity-decoded links and keeps raw HTML, images and task markers inert"
- Mode: run
- Intent: review
- Given: An agent notification includes encoded HTTPS links, a mail link, unsafe or malformed link targets, a tracking image, raw HTML, a bare URL and checked and unchecked tasks.
- When: The notification is rendered as HTML and plain text.
- Then: The HTML links to the decoded HTTPS URL and the valid mail link. Unsafe and malformed links remain readable as plain labels. Raw HTML, image elements and task inputs stay inert, the pixel URL is absent, and neither the raw-HTML anchor nor bare URL becomes a link. Plain text keeps the image label and both task markers.

## agent-notification-email-renderer-004

- Vitest: "pure agent notification email rendering > keeps styled tables, code, emphasis and quotes in the email Markdown subset"
- Mode: run
- Intent: review
- Given: The notification uses a Markdown table, strong and emphasized text, strikethrough, a quote, inline code with special characters and a Mermaid fence.
- When: The notification is rendered as HTML and plain text.
- Then: The HTML preserves a styled presentation table and header, strong and italic text, strikethrough and a styled quote. It escapes the inline code's angle brackets and ampersand and the Mermaid arrow. Plain text keeps the table and quote content.

## agent-notification-email-renderer-005

- Vitest: "pure agent notification email rendering > renders Markdown, preserves safe links, strips tracking images and unsafe anchors, and includes provenance and opt-out"
- Mode: run
- Intent: review
- Given: An agent notification subject contains angle brackets. The body has Markdown, a safe HTTPS link, a tracking image, unsafe links and raw script. A Run URL and unsubscribe URL are provided.
- When: The notification is rendered as HTML and plain text.
- Then: HTML escapes the subject, preserves the safe, Run and unsubscribe links, and includes no script element, unsafe anchor or pixel URL. Plain text contains the emphasized content and unsubscribe label.

## agent-notification-email-renderer-006

- Vitest: "pure agent notification email rendering > uses the original Morning Brief rendering, artwork, management and unsubscribe controls"
- Mode: run
- Intent: review
- Given: The same subject, Markdown body, Run URL, Morning Brief management URL and unsubscribe URL are available for both email purposes.
- When: The Morning Brief and regular agent notification are rendered.
- Then: The Brief includes its original artwork, management link, unsubscribe label and automation provenance, without tracking pixels or unsafe links. The regular email keeps its main heading and agent provenance and omits the Brief artwork and management label.

## agent-notification-email-renderer-007

- Vitest: "pure agent notification email rendering > bounds HTML expansion for either notification purpose"
- Mode: run
- Intent: review
- Given: A regular agent notification contains 1,900 identical Markdown bullet lines.
- When: The notification is rendered as HTML and plain text.
- Then: The HTML is at most 96 KiB in UTF-8 and uses preformatted content. The plain text tells the recipient to open it in the app.

## agent-notification-email-renderer-008

- Vitest: "pure agent notification email rendering > bounds HTML expansion for either notification purpose"
- Mode: run
- Intent: review
- Given: A Morning Brief contains 1,900 identical Markdown bullet lines.
- When: The notification is rendered as HTML and plain text.
- Then: The HTML is at most 96 KiB in UTF-8 and uses preformatted content. The plain text tells the recipient to open it in the app.
