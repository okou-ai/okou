# Chat run composer

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-run-composer.test.tsx](chat-run-composer.test.tsx).

## chat-run-composer-001

Original test `Register the notification worker when the chat opens`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-composer.test.tsx#L46).

- **Given** The user opens a new chat in a browser that supports push notifications, with a VAPID public key configured.
- **When** The chat opens.
- **Then** The browser registers the notification worker at “/sw.js” with cache updates disabled.

## chat-run-composer-002

Original test `Enable completion notifications after a visible send`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-composer.test.tsx#L64).

- **Given** The user opens a new chat in a browser that supports push notifications, with a VAPID public key configured.
- **When** The user sends “Notify me when the launch review is complete.”
- **Then** The message appears in the conversation, the composer clears, a chat run starts, and a push subscription is registered using the browser’s subscription endpoint.

## chat-run-composer-003

Original test `Queue a visual attachment without requiring text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-composer.test.tsx#L103).

- **Given** An active conversation is open and the user has selected the video file “launch-cut.mp4” without entering text.
- **When** The user sends the attachment.
- **Then** The queued message has no text content and contains the uploaded video file with its filename and video content type. A preview for “launch-cut.mp4” appears, and no “(see attached files)” text is shown.

## chat-run-composer-004

Original test `Send a large image with Auto`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-composer.test.tsx#L156).

- **Given** A new chat has no selected model, no available run models, and the user attaches the 12,000,000-byte image “launch-board.png.”
- **When** The user enters “Review this launch board” and sends the message using Auto.
- **Then** The run receives the image file with its filename and image content type, and the message text appears in the conversation.

## chat-run-composer-005

Original test `Show follow-up instructions in the active conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-composer.test.tsx#L208).

- **Given** An active conversation shows an assistant update, the user’s immediate steering message, and a pending automation instruction to send the launch recap tomorrow.
- **When** The user sends “Keep the owner names in the plan.”
- **Then** The pending automation instruction remains visible, the new text is queued and appears after the earlier assistant update and steering message, and a Stop control is visible.
