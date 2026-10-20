import svgpath from "svgpath";
import { z } from "zod";

export const svgPathInputsSchema = z.array(
  z.object({ id: z.number().int().nonnegative(), path: z.string() }),
);

type Point = { x: number; y: number };
type SvgPathPoint =
  | (Point & { moveTo?: boolean })
  | { close: true }
  | (Point & {
      curve:
        | { type: "quadratic"; x1: number; y1: number }
        | {
            type: "cubic";
            x1: number;
            y1: number;
            x2: number;
            y2: number;
          };
    });

/** Normalize SVG's relative, shorthand and arc commands before browser paint. */
export function nativeSvgPath(
  path: string,
): { points: SvgPathPoint[] } | { unsupported: string } {
  const parsed = svgpath(path);
  // svgpath exposes parse errors at runtime but omits them from its declaration.
  if ("err" in parsed && typeof parsed.err === "string" && parsed.err)
    return { unsupported: `Invalid SVG path: ${parsed.err}` };
  const points: SvgPathPoint[] = [];
  parsed
    .abs()
    .unshort()
    .unarc()
    .iterate((segment, _index, x, y) => {
      switch (segment[0]) {
        case "M":
          points.push({ x: segment[1], y: segment[2], moveTo: true });
          break;
        case "L":
          points.push({ x: segment[1], y: segment[2] });
          break;
        case "H":
          points.push({ x: segment[1], y });
          break;
        case "V":
          points.push({ x, y: segment[1] });
          break;
        case "C":
          points.push({
            x: segment[5],
            y: segment[6],
            curve: {
              type: "cubic",
              x1: segment[1],
              y1: segment[2],
              x2: segment[3],
              y2: segment[4],
            },
          });
          break;
        case "Q":
          points.push({
            x: segment[3],
            y: segment[4],
            curve: {
              type: "quadratic",
              x1: segment[1],
              y1: segment[2],
            },
          });
          break;
        case "Z":
        case "z":
          points.push({ close: true });
          break;
        default:
          throw new Error("SVG path normalization left an unsupported command");
      }
    });
  if (
    points.some((point) => {
      if ("close" in point) return false;
      return (
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        ("curve" in point &&
          Object.values(point.curve).some((value) => {
            return typeof value === "number" && !Number.isFinite(value);
          }))
      );
    })
  )
    return { unsupported: "SVG path contains non-finite coordinates" };
  return { points };
}

/** Computed d includes CSS path overrides; preserve the measured node identity. */
export const CAPTURE_SVG_PATHS = String.raw`(() => {
  const state = window.__okouNative;
  return JSON.stringify(state.elements.filter(node =>
    node.namespaceURI === 'http://www.w3.org/2000/svg' && node.localName === 'path'
  ).map(node => {
    const d = getComputedStyle(node).d;
    return { id: state.nodes.get(node).id,
      path: d === 'none' ? '' : d.startsWith('path(') ? JSON.parse(d.slice(5,-1)) : node.getAttribute('d') || '' };
  }));
})()`;
