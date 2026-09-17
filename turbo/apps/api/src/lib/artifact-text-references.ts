export const MAX_ARTIFACT_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_ARTIFACT_TOTAL_TEXT_BYTES = 32 * 1024 * 1024;
export const ARTIFACT_REFERENCE_PATTERN =
  /https?:\/\/[^\s<>"'`)\]]+|\/artifacts\/[^\s<>"'`)\]]+|\/api\/[^\s<>"'`)\]]+/gu;

export function artifactTextContentType(contentType: string): boolean {
  return /^(?:text\/(?:html|css)|(?:application|text)\/(?:javascript|json))(?:;|$)/u.test(
    contentType,
  );
}

export function artifactTextReferences(content: string): string[] {
  return [
    ...new Set(
      [...content.matchAll(ARTIFACT_REFERENCE_PATTERN)].map((match) => {
        return match[0].replace(/[.,;!]+$/u, "");
      }),
    ),
  ];
}
