import { escapeUTF8 } from "entities/escape";
import { Parser } from "htmlparser2";

export interface ArtifactOgMetadata {
  readonly title: string;
  readonly description: string;
  readonly imageUrl: string;
  readonly url: string;
}

export const GENERIC_ARTIFACT_TITLE = "Shared artifact";
export const GENERIC_ARTIFACT_DESCRIPTION =
  "Open in Okou to view this artifact.";

function inspectHtml(html: string) {
  const tags: { start: number; end: number; name: string; content: string }[] =
    [];
  let title = "";
  let titleStart: number | undefined;
  let readingTitle = false;
  let titleText = "";
  let bodyStarted = false;
  let ignoredDepth = 0;
  const ignoredTags = new Set(["template", "svg", "math"]);
  let headEnd: number | undefined;
  let documentStart = 0;
  const parser = new Parser({
    onprocessinginstruction(name) {
      if (name.toLowerCase() === "!doctype")
        documentStart = parser.endIndex + 1;
    },
    onopentag(name, attributes) {
      if (ignoredTags.has(name)) ignoredDepth += 1;
      if (ignoredDepth > 0) return;
      if (name === "body") bodyStarted = true;
      if (bodyStarted) return;
      if (name === "html") documentStart = parser.endIndex + 1;
      if (name === "title") {
        readingTitle = true;
        titleText = "";
        titleStart = parser.startIndex;
      }
      if (name === "meta") {
        tags.push({
          start: parser.startIndex,
          end: parser.endIndex + 1,
          name: (attributes.property ?? attributes.name ?? "").toLowerCase(),
          content: attributes.content ?? "",
        });
      }
      if (name === "link" && attributes.rel?.toLowerCase() === "canonical") {
        tags.push({
          start: parser.startIndex,
          end: parser.endIndex + 1,
          name: "canonical",
          content: attributes.href ?? "",
        });
      }
    },
    ontext(text) {
      if (readingTitle) titleText += text;
    },
    onclosetag(name) {
      if (ignoredTags.has(name)) {
        ignoredDepth -= 1;
        return;
      }
      if (ignoredDepth > 0 || bodyStarted) return;
      if (name === "head") headEnd ??= parser.startIndex;
      if (name === "title") {
        readingTitle = false;
        if (!title) title = titleText;
        if (titleStart !== undefined)
          tags.push({
            start: titleStart,
            end: parser.endIndex + 1,
            name: "title",
            content: titleText,
          });
        titleStart = undefined;
      }
    },
  });
  parser.end(html);
  return { tags, title: title.trim().slice(0, 300), headEnd, documentStart };
}

export function artifactHtmlMetadata(html: string) {
  const parsed = inspectHtml(html);
  const content = (name: string) => {
    return parsed.tags
      .find((tag) => {
        return tag.name === name && tag.content.trim();
      })
      ?.content.trim();
  };
  return {
    title: (content("og:title") ?? parsed.title).slice(0, 300),
    description: (
      content("og:description") ??
      content("description") ??
      ""
    ).slice(0, 500),
  };
}

function validTag(name: string, value: string): boolean {
  if (!value.trim()) return false;
  if (!["og:image", "twitter:image", "og:url"].includes(name)) return true;
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    ["https:", "http:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}

/** Edit only metadata ranges; script, style and authored body bytes stay intact. */
export function artifactOgHtml(
  html: string,
  metadata: ArtifactOgMetadata,
  replace: boolean,
): string {
  const parsed = inspectHtml(html);
  const authoredImage = !replace
    ? parsed.tags.find((tag) => {
        return tag.name === "og:image" && validTag(tag.name, tag.content);
      })?.content
    : undefined;
  const defaults = new Map([
    ["og:type", "website"],
    ["og:title", metadata.title],
    ["og:description", metadata.description],
    ["og:url", metadata.url],
    ["og:image", metadata.imageUrl],
    ["og:image:alt", metadata.title],
    ["twitter:card", "summary_large_image"],
    ["twitter:title", metadata.title],
    ["twitter:description", metadata.description],
    ["twitter:image", authoredImage ?? metadata.imageUrl],
  ]);
  const edits: { start: number; end: number; text: string }[] = [];
  const supported = new Set(defaults.keys());
  for (const tag of parsed.tags) {
    const social =
      tag.name.startsWith("og:") || tag.name.startsWith("twitter:");
    if (
      replace &&
      (social || ["title", "description", "canonical"].includes(tag.name))
    ) {
      edits.push({ ...tag, text: "" });
    } else if (!replace && supported.has(tag.name)) {
      if (validTag(tag.name, tag.content)) defaults.delete(tag.name);
      else edits.push({ ...tag, text: "" });
    }
  }
  if (!replace && defaults.has("og:image")) {
    // Dimensions/type/secure URL describe the old image, not the replacement.
    for (const tag of parsed.tags) {
      if (
        [
          "og:image:width",
          "og:image:height",
          "og:image:type",
          "og:image:secure_url",
        ].includes(tag.name)
      ) {
        edits.push({ ...tag, text: "" });
      }
    }
  }
  const tags = [...defaults]
    .map(([name, content]) => {
      return `<meta ${name.startsWith("og:") ? "property" : "name"}="${name}" content="${escapeUTF8(content)}">`;
    })
    .join("");
  const extra = replace
    ? `<title>${escapeUTF8(metadata.title)}</title><meta name="description" content="${escapeUTF8(metadata.description)}"><link rel="canonical" href="${escapeUTF8(metadata.url)}">`
    : "";
  const at = parsed.headEnd ?? parsed.documentStart;
  edits.push({
    start: at,
    end: at,
    text:
      parsed.headEnd === undefined
        ? `<head>${extra}${tags}</head>`
        : `${extra}${tags}`,
  });
  edits.sort((left, right) => {
    return right.start - left.start;
  });
  for (const edit of edits)
    html = html.slice(0, edit.start) + edit.text + html.slice(edit.end);
  return html;
}
