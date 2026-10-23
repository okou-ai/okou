import { escapeUTF8 } from "entities/escape";
import { Parser } from "htmlparser2";

/** Permit only the platform's nonce-bearing chrome alongside the original policy. */
export function hostedSiteBannerCsp(policy: string, nonce: string) {
  return policy
    .split(",")
    .map((part) => {
      const directives = new Map<string, string[]>();
      for (const item of part.split(";")) {
        const [name = "", ...values] = item.trim().split(/\s+/u);
        const key = name.toLowerCase();
        if (key && !directives.has(key)) directives.set(key, values);
      }
      for (const kind of ["script", "style"] as const) {
        const key = `${kind}-src-elem`;
        const sources =
          directives.get(key) ??
          directives.get(`${kind}-src`) ??
          directives.get("default-src");
        // Adding a nonce would disable an existing unsafe-inline allowance.
        // Leave that policy alone when it already permits our inline chrome.
        if (
          sources?.some((source) => {
            return source.toLowerCase() === "'unsafe-inline'";
          }) &&
          !sources.some((source) => {
            return /^'(?:nonce-|sha(?:256|384|512)-)[A-Za-z0-9+/_-]+={0,2}'$/iu.test(
              source,
            );
          })
        )
          continue;
        if (sources)
          directives.set(key, [
            ...sources.filter((source) => {
              return source !== "'none'";
            }),
            `'nonce-${nonce}'`,
          ]);
      }
      const images = directives.get("img-src") ?? directives.get("default-src");
      if (images)
        directives.set("img-src", [
          ...images.filter((source) => {
            return source !== "'none'";
          }),
          "https://static.okou.io",
        ]);
      return [...directives]
        .map(([key, values]) => {
          return `${key} ${values.join(" ")}`;
        })
        .join("; ");
    })
    .join(", ");
}

/** Preserve publisher bytes and paths; decorate only this delivered document. */
export function injectHostedSiteBanner(
  html: string,
  banner: string,
  nonce: string,
) {
  let body: number | undefined;
  let headEnd: number | undefined;
  let documentStart = 0;
  let ignoredDepth = 0;
  const changes: { start: number; end: number; value: string }[] = [];
  const ignored = new Set(["template", "svg", "math"]);
  const parser = new Parser({
    onprocessinginstruction(name) {
      if (name.toLowerCase() === "!doctype")
        documentStart = parser.endIndex + 1;
    },
    onopentag(name, attributes) {
      if (ignored.has(name)) ignoredDepth += 1;
      if (ignoredDepth > 0) return;
      if (name === "html") documentStart = parser.endIndex + 1;
      if (name === "body") body ??= parser.endIndex + 1;
      if (
        name === "meta" &&
        attributes["http-equiv"]?.toLowerCase() === "content-security-policy" &&
        attributes.content
      ) {
        const updated = {
          ...attributes,
          content: hostedSiteBannerCsp(attributes.content, nonce),
        };
        changes.push({
          start: parser.startIndex,
          end: parser.endIndex + 1,
          value: `<meta ${Object.entries(updated)
            .map(([key, value]) => {
              return `${key}="${escapeUTF8(value)}"`;
            })
            .join(" ")}>`,
        });
      }
    },
    onclosetag(name) {
      if (ignored.has(name)) ignoredDepth -= 1;
      if (name === "head" && ignoredDepth === 0) headEnd = parser.endIndex + 1;
    },
  });
  parser.end(html);
  const start = body ?? headEnd ?? documentStart;
  changes.push({ start, end: start, value: banner });
  changes.sort((left, right) => {
    return right.start - left.start;
  });
  let output = html;
  for (const change of changes)
    output =
      output.slice(0, change.start) + change.value + output.slice(change.end);
  return output;
}
