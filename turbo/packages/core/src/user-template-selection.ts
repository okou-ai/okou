/**
 * Where a custom template's package is mounted for the run, relative to the
 * working directory.
 *
 * A directory rather than a skills-root mount, because the skills root is
 * chosen per framework inside run creation while this path has to appear in a
 * prompt built before a framework exists. It sits beside the built-in
 * templates' `./generated/resources/<slug>`, so both kinds of package are
 * somewhere the agent already looks.
 *
 * Distinct from the presentation table's `generated/presentation-template/`.
 * The two tables have separate id spaces and, until the fold-in, a run can
 * mount from both; sharing a directory would let one overwrite the other.
 *
 * The leaf is the row id, not the member's title: a title is arbitrary text
 * that two templates can share, and one message may attach several.
 */
export function userTemplateDirectory(templateId: string): string {
  return `generated/user-template/${templateId}`;
}
