# Composer website recommendation previews

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [composer-website-recommendation-previews.test.tsx](composer-website-recommendation-previews.test.tsx).

## composer-website-recommendation-previews-001

Original test `Website recommendation dismissal returns to its Eye without changing the draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-website-recommendation-previews.test.tsx#L122).

- **Given** A Website template shelf is open with the original draft text and no selected template.
- **When** The user opens the website preview, then dismisses it with Close or Escape.
- **Then** The preview closes and focus returns to the preview control. The shelf remains open; the draft is unchanged, no template is attached, and no message is sent.

## composer-website-recommendation-previews-002

Original test `The Website Eye is Tab reachable and Enter/Space preview without selecting`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-website-recommendation-previews.test.tsx#L149).

- **Given** The Website template shelf is open and the original draft is present.
- **When** The user tabs from the template selection control to the preview control, then activates it with Enter or Space.
- **Then** The website preview opens without selecting the template. Dismissing it with Escape returns focus to the preview control; the draft remains unchanged, no template is attached, and no message is sent.

## composer-website-recommendation-previews-003

Original test `Selecting the original Website cover after preview attaches and serializes that website`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-website-recommendation-previews.test.tsx#L167).

- **Given** The Website template shelf is open, and the user has entered new draft text.
- **When** The user previews the website, closes the preview, selects the original website cover, and sends the message.
- **Then** The website is attached while the entered text remains. The sent message contains the text and a website template selection with that website's ID.

## composer-website-recommendation-previews-004

Original test `View all resets direct Website preview dismissal to the normal gallery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-website-recommendation-previews.test.tsx#L197).

- **Given** The user has opened and dismissed a direct website preview from the Website template shelf.
- **When** The user opens View all, then previews the website from the gallery and dismisses it with Close or Escape.
- **Then** The gallery remains visible with Website selected, and focus returns to the gallery's preview control. The embedded preview uses the same URL and sandbox as the direct preview; the draft remains unchanged, no template is attached, and no message is sent.
