const MAX_URL_LABEL_LENGTH = 80;

/** Keep the complete address in href and expose it on hover when shortened. */
export function urlLabel(text: string) {
  if (text.length <= MAX_URL_LABEL_LENGTH) {
    return text;
  }
  const characters = Array.from(text);
  if (characters.length <= MAX_URL_LABEL_LENGTH) {
    return text;
  }
  return (
    <span title={text}>
      {characters.slice(0, MAX_URL_LABEL_LENGTH - 3).join("")}...
    </span>
  );
}
