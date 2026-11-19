# Chat composer presentation gallery

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-presentation-gallery.test.tsx](chat-composer-presentation-gallery.test.tsx).

## chat-composer-presentation-gallery-001

Original test `Select a presentation theme from its preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-presentation-gallery.test.tsx#L115).

- **Given** The user is editing a new chat with a presentation template selected and its theme preview open.
- **When** The user selects the “Deep dive” style and then selects the template.
- **Then** The template remains in the composer and the saved draft includes that template with color system “color-system:ocean-deep.” No message is sent.

## chat-composer-presentation-gallery-002

Original test `Send a presentation theme restored from a saved draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-presentation-gallery.test.tsx#L176).

- **Given** A saved draft restores a presentation template with color system “color-system:ocean-deep.”
- **When** The user sends “Create the quarterly presentation.”
- **Then** The sent message contains the presentation template with its saved template ID and the restored “color-system:ocean-deep” theme.

## chat-composer-presentation-gallery-003

Original test `Use a presentation template's default theme`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-presentation-gallery.test.tsx#L200).

- **Given** The user is composing a new chat with no presentation template selected.
- **When** The user selects the built-in presentation template and sends “Create a presentation with this template.”
- **Then** The sent message contains that template with its default theme.

## chat-composer-presentation-gallery-004

Original test `Navigate every slide in a presentation template`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-presentation-gallery.test.tsx#L228).

- **Given** The user previews a four-slide presentation template, initially on slide 1.
- **When** The user advances with the next-slide control, uses the right arrow, selects slide 4, tries to advance again, then goes back once.
- **Then** Slide 1 has no previous-slide action. The preview advances through slides 2, 3, and 4; it stays on slide 4 at the end, then returns to visible slide 3 using the previous-slide control.

## chat-composer-presentation-gallery-005

Original test `Count slides and pick a theme by name in a presentation template preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-presentation-gallery.test.tsx#L302).

- **Given** The user previews a three-slide presentation template on slide 1, and the preview lists the “Candy party” and “Deep dive” themes.
- **When** The user advances one slide and selects “Deep dive.”
- **Then** The preview shows slide 2 of 3 before and after selecting the theme, and “Deep dive” is marked selected.

## chat-composer-presentation-gallery-006

Original test `Step back through a presentation template from its filmstrip`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-presentation-gallery.test.tsx#L318).

- **Given** The user previews a three-slide presentation template.
- **When** The user selects slide 3 in the filmstrip and presses the left arrow.
- **Then** The preview moves from slide 3 of 3 to slide 2 of 3, with slide 2 selected.

## chat-composer-presentation-gallery-007

Original test `A slide already on the stage takes a new theme as soon as it is picked`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-presentation-gallery.test.tsx#L366).

- **Given** A presentation template preview is open, and its staged slide is rendered with accent color “#7257E6.”
- **When** The user selects the “Deep dive” theme.
- **Then** The staged slide immediately changes to accent color “#38C7B4.”
