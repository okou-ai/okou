# Composer, template, and rendered preview coverage

| File                                      | Frozen rows | Passing selected rows |
| ----------------------------------------- | ----------: | --------------------: |
| chat-official-template-previews           |          11 |                     6 |
| chat-run-history-preview                  |           3 |                     2 |
| composer-pasted-text                      |           9 |                     5 |
| composer-template-recommendation-previews |           9 |                     5 |
| composer-tools                            |           5 |                     3 |
| composer-visualization-preferences        |           8 |                     4 |
| composer-website-recommendation-previews  |           4 |                     2 |
| diagram-rendering                         |           2 |                     1 |
| markdown-cjk-emphasis                     |           9 |                     5 |
| markdown-content                          |           9 |                     5 |
| markdown-interactions                     |           4 |                     2 |
| markdown-math                             |           2 |                     1 |
| markdown-mermaid                          |           3 |                     2 |
| markdown-parser-isolation                 |           4 |                     2 |
| markdown-time                             |           4 |                     2 |
| paid-media-creation                       |           4 |                     2 |
| presentation-output-format                |           9 |                     5 |
| presentation-preview                      |           4 |                     2 |
| raw-video-thumbnail                       |           3 |                     2 |
| thread-resource-thumbnails                |           3 |                     2 |
| Total                                     |         109 |                    60 |

The tests enter through the production Router with shared chat, API, browser,
and preview fixtures. They cover template recommendation and opening,
presentation format and rendering, composer behavior, Markdown rendering,
attachments and thumbnails, and historical previews.

The execution ledger maps actual Vitest expansions to the selected IDs in
both directions. The GWT checklist records each condition, action, and outcome.
Targeted Vitest, test TypeScript, ESLint, and Oxlint passed before removal of
the corresponding BDD files.

The oversized GWT checklist was split at a frozen-ID boundary into volumes 2
and 3. Recombining both volumes reproduces the original data rows byte for
byte, and each volume fits the repository file size limit.
