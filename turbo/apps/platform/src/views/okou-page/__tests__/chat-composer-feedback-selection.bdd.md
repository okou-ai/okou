# Chat composer feedback selection

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-feedback-selection.test.tsx](chat-composer-feedback-selection.test.tsx).

## chat-composer-feedback-selection-001

Original test `keep the caret in quote text after ArrowDown at its end > preserves the complete scenario`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-feedback-selection.test.tsx#L76).

- **Given** A completed conversation contains the quote “The launch plan has three careful stages.”, and the user has opened a quote note containing “Keep this review in the quote.” with the caret at its end.
- **When** The user presses ArrowDown, types an exclamation mark, and sends the quote note.
- **Then** ArrowDown keeps the caret collapsed at the end of the note text. The note becomes “Keep this review in the quote.!” and the sent message includes that note with the selected quote.
