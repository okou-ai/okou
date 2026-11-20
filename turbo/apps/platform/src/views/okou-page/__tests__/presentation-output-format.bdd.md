# Presentation output format

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [presentation-output-format.test.tsx](presentation-output-format.test.tsx).

## presentation-output-format-001

Original test `Presentation defaults to HTML and submits HTML as a preference without rewriting the user's prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/presentation-output-format.test.tsx#L70).

- **Given** An authenticated owner has presentation format selection enabled, and HTML is initially selected.
- **When** The user selects a presentation template and sends the prompt “Our launch deck; use PPTX for this one” without changing the format.
- **Then** The submitted preference and template selection specify HTML, while the prompt remains unchanged and the instructions say the message can override the preference for format or slide count.

## presentation-output-format-002

Original test `Presentation defaults to HTML and submits PPTX as a preference without rewriting the user's prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/presentation-output-format.test.tsx#L70).

- **Given** An authenticated owner has presentation format selection enabled, and HTML is initially selected.
- **When** The user chooses PPTX, selects a presentation template, and sends the prompt “Our launch deck; use PPTX for this one.”
- **Then** The submitted preference and template selection specify PPTX, while the prompt remains unchanged and the instructions say the message can override the preference for format or slide count.

## presentation-output-format-003

Original test `A format changed after choosing a template is frozen at send time`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/presentation-output-format.test.tsx#L122).

- **Given** An authenticated owner has opened presentation format selection and entered a prompt.
- **When** The user selects a presentation template, changes the format to PPTX, and sends the message.
- **Then** The sent template selection specifies PPTX.

## presentation-output-format-004

Original test `A restored feedback template freezes the changed format when sent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/presentation-output-format.test.tsx#L147).

- **Given** An authenticated owner has a restored feedback draft quoting “Revise the launch deck,” with a presentation template set to HTML in the feedback note.
- **When** The user changes the format to PPTX and sends the feedback.
- **Then** The sent feedback preserves the quote and surrounding note text, and its embedded template selection specifies PPTX.

## presentation-output-format-005

Original test `A changed format survives a fresh page and is shared by Chart presentation output`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/presentation-output-format.test.tsx#L214).

- **Given** An authenticated owner has changed the presentation format preference to PPTX.
- **When** The user loads a fresh page, chooses Chart output as Presentation, enters “Explain our quarterly results,” and sends it.
- **Then** PPTX remains selected for both presentation format controls, and the sent instructions identify presentation (PPTX), include the PPTX generation command, and identify presentation as the user-selected output type.

## presentation-output-format-006

Original test `Chart presentation output uses HTML until the user changes the preference`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/presentation-output-format.test.tsx#L278).

- **Given** An authenticated owner has presentation format selection enabled and has not changed its preference.
- **When** The user chooses Chart output as Presentation and sends “Visualize our results.”
- **Then** The sent instructions identify presentation (HTML) as the preferred output format.

## presentation-output-format-007

Original test `A presentation format preference does not change another Chart output type`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/presentation-output-format.test.tsx#L308).

- **Given** An authenticated owner has changed the presentation format preference to PPTX.
- **When** The user chooses Website as the Chart output type and sends “Make a dashboard.”
- **Then** The sent instructions identify website as the preferred output format and do not mention PPTX.

## presentation-output-format-008

Original test `Peers cannot enable presentation format through a stored opt-in`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/presentation-output-format.test.tsx#L338).

- **Given** A peer without owner authentication has presentation format selection enabled, even if stored opt-in data exists.
- **When** The peer chooses Presentation, selects a template, and sends “Prepare our deck.”
- **Then** No output format selection is available, and the sent template has no output-format selection.

## presentation-output-format-009

Original test `Presentation uses its existing defaults when output format selection is disabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/presentation-output-format.test.tsx#L365).

- **Given** An authenticated owner has presentation format selection disabled.
- **When** The user chooses Presentation, selects a template, and sends “Prepare our deck.”
- **Then** No output format selection is available, and the template has no output format. The sent instructions retain the existing defaults, including a slide count of 8–12 and the rule that the message may override slide count.
