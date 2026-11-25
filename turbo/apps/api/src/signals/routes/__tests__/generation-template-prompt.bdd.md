# generation-template-prompt

## generation-template-prompt-001

- Vitest: "buildGenerationTemplatePrompt > builds one shared context for multiple ordered templates"
- Mode: run
- Intent: review
- Given: A message selects two inline templates in order: the first registered illustration style and the first registered workflow template.
- When: The generation template prompt is built for both selections together.
- Then: The result is `resolved` with exactly one `# Inline Templates` heading and no separate artifact or workflow context headings. It contains `## Template #1 (illustration)` and `## Template #2 (workflow)`, instructions to match each numbered marker, apply each template only around its marker, and treat a template as context rather than a request, plus the illustration style ID and workflow template ID.

## generation-template-prompt-002

- Vitest: "buildGenerationTemplatePrompt > builds legacy html presentation guidance and the Okou image batch command by default"
- Mode: run
- Intent: review
- Given: Row `html`: the Playful Launch Presentation template is selected with output format `html` and its own color system.
- When: The generation template prompt is built for the selection.
- Then: The result is `resolved` with `# Artifact Template Context`, the selected template name and ID, `okou resource pull template:html-ppt-playful-launch-runbook --dir ./generated/resources`, the `./generated/resources/playful-launch/SKILL.md` path, color token `carnival`, HTML-only guidance (keep slides in `index.html`, host with `okou host ... --artifact-kind presentation-html` and optional `--title`, deliver HTML unless PPTX is explicitly requested), and the message-overrides-format guidance with `okou generate presentation --format <html|pptx>`. It has no `# Presentation Output Preference`, and exactly one "Image workflow" line ordering `image-batch start`, deck authoring, `image-batch wait`, and `results.tsv`.

## generation-template-prompt-003

- Vitest: "buildGenerationTemplatePrompt > builds legacy pptx presentation guidance and the Okou image batch command by default"
- Mode: run
- Intent: review
- Given: Row `pptx`: the Playful Launch Presentation template is selected with output format `pptx` and its own color system.
- When: The generation template prompt is built for the selection.
- Then: The result is `resolved` with `# Artifact Template Context`, the selected template name and ID, `okou resource pull template:pptx-playful-launch-runbook --dir ./generated/resources/pptx`, the `./generated/resources/pptx/playful-launch-native/SKILL.md` path, color token `carnival`, native PPTX guidance (author editable PPTX directly, follow the package's export and verification workflow, deliver the `.pptx` with the upload-file command and return its exact URL), and the message-overrides-format guidance. It has no `# Presentation Output Preference`, and exactly one "Image workflow" line ordering `image-batch start`, deck authoring, `image-batch wait`, and `results.tsv`.

## generation-template-prompt-004

- Vitest: "buildGenerationTemplatePrompt > keeps imported templates on legacy HTML delivery guidance by default"
- Mode: run
- Intent: review
- Given: A user-imported presentation template is selected with output format `pptx`, and the Run mounts that template's package.
- When: The generation template prompt is built for the selection.
- Then: The result is `resolved` with `# Artifact Template Context`, the mount path `./generated/presentation-template/<id>` and its `SKILL.md`, HTML/CSS/SVG authoring, the image-batch start and wait commands, "Do not produce slide JSON", `tokens.json`, HTML hosting and default-HTML delivery guidance, and the PPTX conversion instruction. It contains no `# Presentation Output Preference`, no `okou resource pull`, and no `presentation-template@` storage key.

## generation-template-prompt-005

- Vitest: "buildGenerationTemplatePrompt > emits no guidance for a private template the run does not mount"
- Mode: run
- Intent: review
- Given: A user-imported presentation template is selected, but the Run mounts no user templates.
- When: The generation template prompt is built for the selection.
- Then: The result is `invalid` with message "Presentation template not found".

## generation-template-prompt-006

- Vitest: "buildGenerationTemplatePrompt > emits guidance only for the mounted one when several are selected"
- Mode: run
- Intent: review
- Given: Two user-imported presentation templates are selected, and the Run mounts only the first.
- When: The generation template prompt is built for both selections together.
- Then: The whole result is `invalid` with message "Presentation template not found".

## generation-template-prompt-007

- Vitest: "buildGenerationTemplatePrompt > falls back to the default color token when none is selected"
- Mode: run
- Intent: review
- Given: The Playful Launch Presentation template is selected without a color system.
- When: The generation template prompt is built for the selection.
- Then: The result is `resolved` and contains "Color system token: carnival".

## generation-template-prompt-008

- Vitest: "buildGenerationTemplatePrompt > builds illustration template guidance"
- Mode: run
- Intent: review
- Given: The first registered illustration style is selected.
- When: The generation template prompt is built for the selection.
- Then: The result is `resolved` with `# Artifact Template Context`, the style ID and description, the `okou generate image --provider built-in --style <id> --prompt "<user request>" --compile --style-source r2` command, the private R2 style source, instructions to follow the returned packet and stop without falling back to GitHub when R2 is unavailable, and mentions of `--compiled-prompt`, resolved compatible CLI options, and required reference image URLs.

## generation-template-prompt-009

- Vitest: "buildGenerationTemplatePrompt > builds workflow template guidance"
- Mode: run
- Intent: review
- Given: The first registered workflow template (the auto-inbox label workflow) is selected.
- When: The generation template prompt is built for the selection.
- Then: The result is exactly `resolved` with the template's own prompt guidance, which contains `# Workflow Template Context`, `Auto-inbox label (<id>)`, "Use the workflow-setup skill", and "Gmail label-applied automation".

## generation-template-prompt-010

- Vitest: "buildGenerationTemplatePrompt > builds website template package guidance"
- Mode: run
- Intent: review
- Given: The first registered website template is selected, and its current template package is registered.
- When: The generation template prompt is built for the selection.
- Then: The result is `resolved` with `# Artifact Template Context`, the template title and ID, package ID and resource, archive SHA-256, `okou resource pull <id> --dir ./generated/resources`, the package `SKILL.md` path, and the `node tools/compose.mjs` assembly step. It has exactly one image-workflow line covering the TSV manifest, `image-batch start`/`wait`, authoring while it runs, `results.tsv`, `data-generation-size`, skipping without a manifest, keeping state outside the site, and never calling `okou generate image` directly; it also mentions `QA_READY`, `okou host ./publish --site <slug>`, `checks/verify-published.sh <url>`, and the built-in R2-backed package.

## generation-template-prompt-011

- Vitest: "buildGenerationTemplatePrompt > selects every current website template package"
- Mode: run
- Intent: review
- Given: Each registered website template is selected in turn.
- When: The generation template prompt is built for each selection.
- Then: Every result is `resolved` and contains its `okou resource pull <package id> --dir ./generated/resources` command, the package ID and resource lines, its `SKILL.md` path, and the `okou generate image-batch start <manifest.tsv> <state-dir>` command.
