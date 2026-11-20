# Chat core behavior

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-core-behavior.test.tsx](chat-core-behavior.test.tsx).

## chat-core-behavior-001

Original test `A follow-up during an active run appears immediately`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-core-behavior.test.tsx#L39).

- **Given** A chat thread has an active run, with existing user and assistant messages. The assistant is reviewing dependencies.
- **When** The user sends the follow-up “请继续检查发布计划，并确认所有风险项。” while the append response is still pending.
- **Then** The follow-up appears immediately as a user message and the message box clears, even though the append has not completed. No queued-message label appears, and the submitted follow-up matches the text the user sent.

## chat-core-behavior-002

Original test `A new message keeps its attachment, text, and selected model together`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-core-behavior.test.tsx#L105).

- **Given** The user starts a new chat with GPT 6 Luna selected and attaches the text file brief.txt.
- **When** The user enters “Review the launch brief.” and sends the message.
- **Then** The send request contains the prompt “Review the launch brief.” and preserves the attachment and selected model together in the user message: brief.txt with its upload ID and text/plain type, followed by the text and GPT 6 Luna selection.
