/** Append attribution once at the provider boundary, leaving saved input intact. */
export function appendIntegrationMessageFooter(
  text: string | undefined,
  footerText: string | undefined,
  maxLength?: number,
): string {
  const result = [text, footerText].filter(Boolean).join("\n\n");
  // A full provider-limited caption must remain sendable without losing input.
  return maxLength !== undefined && result.length > maxLength
    ? (text ?? "")
    : result;
}

export function escapeSlackFooterLabel(text: string | undefined) {
  return text?.replace(/[&<>]/gu, (character) => {
    return character === "&" ? "&amp;" : character === "<" ? "&lt;" : "&gt;";
  });
}

export function escapeMarkdownFooterLabel(text: string | undefined) {
  return text?.replace(/[\\`*_[\]~<>]/gu, String.raw`\$&`);
}
