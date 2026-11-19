# Paid media creation

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [paid-media-creation.test.tsx](paid-media-creation.test.tsx).

## paid-media-creation-001

Original test `Explicit image creation shows the notice and stays blocked while image generation is off`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-media-creation.test.tsx#L70).

- **Given** The user explicitly selects image creation while image generation is disabled for them.
- **When** They enter an image prompt and send it.
- **Then** The disabled notice and Open settings action are shown; sending remains blocked, no run prompt is submitted, and the typed prompt remains in the editor.

## paid-media-creation-002

Original test `An image creation notice opens settings and a confirmed save restores creation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-media-creation.test.tsx#L90).

- **Given** The user explicitly selects image creation while image generation is disabled, and a model is available for running prompts.
- **When** They open settings, enable image generation, close settings, and send an image prompt.
- **Then** The disabled notice clears after the confirmed setting change, and one run prompt is submitted.

## paid-media-creation-003

Original test `A failed preference read blocks explicit creation but ordinary chat remains available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-media-creation.test.tsx#L142).

- **Given** The image-generation preference request fails with a temporary service error.
- **When** The user selects image creation and tries to send a prompt, then removes image creation and sends ordinary chat.
- **Then** Explicit creation is blocked and the service error is shown with no run submitted; ordinary chat remains available and submits one run.

## paid-media-creation-004

Original test `Gallery notices follow each paid branch for a member using default feature switches`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/paid-media-creation.test.tsx#L166).

- **Given** A member using the default feature switches opens the template gallery while image generation is disabled for them.
- **When** They view the Image category and then switch to Website.
- **Then** The Image category shows the image-generation-disabled notice, while the Website category shows its template selection without an “is off for you” notice.
