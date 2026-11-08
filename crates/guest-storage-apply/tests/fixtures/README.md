# Template guidance fixture

`template-guidance-v1.tar.gz` was produced by
`prepareTemplateGuidanceBundle` in `turbo/packages/core/src/template-guidance-bundle.ts`.
Its descriptor is `template-guidance-v1.json`. It contains three regular 0644 files:

- `SKILL.md`: `# Use the selected template\n`
- `design-system.md`: `Keep the source's typography.\n`
- `references/` followed by fourteen `template-reference-assets` directories and
  `sample.bin`: bytes `00 ff 80 01`.

The TypeScript reader and native Guest both consume these exact compressed bytes.
The long PAX path protects cross-language decoding and the descriptor protects the
complete compressed identity. Regenerate with the production encoder when the
canonical format intentionally changes; do not substitute a system tar archive.
