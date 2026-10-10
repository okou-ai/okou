import { z } from "zod";

const colorSchema = z.object({
  color: z.string().regex(/^[\dA-F]{6}$/u),
  alpha: z.number().min(0).max(1),
});
const fillSchema = z.object({
  kind: z.enum(["solid", "linear", "radial"]),
  angle: z.number().finite().optional(),
  center: z.tuple([z.number(), z.number()]).optional(),
  radius: z.tuple([z.number().positive(), z.number().positive()]).optional(),
  stops: z
    .array(colorSchema.extend({ position: z.number().min(0).max(1) }))
    .min(1),
});
const paintSchema = z.object({
  fill: fillSchema.optional(),
  textFill: fillSchema.optional(),
  textStroke: colorSchema
    .extend({ width: z.number().nonnegative() })
    .optional(),
  noTextFill: z.boolean().optional(),
  grayscale: z.boolean().optional(),
  crop: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  cells: z.array(z.array(fillSchema.nullable())).optional(),
  mathGroup: z.number().int().nonnegative().optional(),
});
export const nativePaintSchema = z.record(
  z.string(),
  z.record(z.string(), paintSchema),
);
export type NativePaint = z.infer<typeof nativePaintSchema>;

function colorXml(color: z.infer<typeof colorSchema>): string {
  return `<a:srgbClr val="${color.color}"><a:alpha val="${Math.round(color.alpha * 100_000)}"/></a:srgbClr>`;
}
function fillXml(fill: z.infer<typeof fillSchema>): string {
  const first = fill.stops[0];
  if (first === undefined) throw new Error("Native fill has no color stops");
  if (fill.kind === "solid")
    return `<a:solidFill>${colorXml(first)}</a:solidFill>`;
  const stops = fill.stops
    .map((stop, index) => {
      const next = fill.stops[index + 1];
      const position = Math.round(stop.position * 100_000);
      const hardEdge =
        next &&
        Math.round(next.position * 100_000) === position &&
        position > 0;
      return `<a:gs pos="${hardEdge ? position - 1 : position}">${colorXml(stop)}</a:gs>`;
    })
    .join("");
  const center = fill.center ?? [0.5, 0.5];
  const geometry =
    fill.kind === "linear"
      ? `<a:lin ang="${Math.round((fill.angle ?? 0) * 60_000)}" scaled="1"/>`
      : `<a:path path="circle"><a:fillToRect l="${Math.round(center[0] * 100_000)}" t="${Math.round(center[1] * 100_000)}" r="${Math.round((1 - center[0]) * 100_000)}" b="${Math.round((1 - center[1]) * 100_000)}"/></a:path>`;
  return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst>${geometry}</a:gradFill>`;
}

/**
 * DrawingML's radial fill reaches the corners of its coordinate frame. Keep
 * the CSS radius in that frame and move the editable path inside it; changing
 * only fillToRect preserves the center but silently changes the CSS extent.
 */
function radialFrame(
  shape: string,
  fill: z.infer<typeof fillSchema>,
): { shape: string; fill: z.infer<typeof fillSchema> } {
  if (fill.kind !== "radial" || !fill.radius || !shape.includes("<a:custGeom>"))
    return { shape, fill };
  const transform =
    /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/u.exec(
      shape,
    );
  if (!transform) throw new Error("Native radial path has no coordinate frame");
  const x = Number(transform[1]),
    y = Number(transform[2]),
    width = Number(transform[3]),
    height = Number(transform[4]);
  const center = fill.center ?? [0.5, 0.5],
    halfWidth = (fill.radius[0] * width) / Math.SQRT2,
    halfHeight = (fill.radius[1] * height) / Math.SQRT2;
  const dx = halfWidth - center[0] * width,
    dy = halfHeight - center[1] * height;
  const frame = shape
    .replace(
      transform[0],
      `<a:off x="${Math.round(x - dx)}" y="${Math.round(y - dy)}"/><a:ext cx="${Math.round(2 * halfWidth)}" cy="${Math.round(2 * halfHeight)}"/>`,
    )
    .replace(/<a:custGeom>[\s\S]*?<\/a:custGeom>/u, (path) => {
      return path
        .replace(
          /<a:pt x="(-?\d+)" y="(-?\d+)"\/>/gu,
          (_match: string, px: string, py: string) => {
            return `<a:pt x="${Math.round(Number(px) + dx)}" y="${Math.round(Number(py) + dy)}"/>`;
          },
        )
        .replace(
          /<a:path w="\d+" h="\d+"/gu,
          `<a:path w="${Math.round(2 * halfWidth)}" h="${Math.round(2 * halfHeight)}"`,
        );
    });
  return { shape: frame, fill: { ...fill, center: [0.5, 0.5] } };
}

/** Return direct XML children, leaving nested paths and border paint intact. */
function childrenOf(xml: string): { tag: string; xml: string }[] {
  const children: { tag: string; xml: string }[] = [];
  let depth = 0;
  let start = 0;
  let tag = "";
  for (const match of xml.matchAll(/<\/?([\w:.-]+)\b[^>]*>/gu)) {
    const closing = match[0].startsWith("</");
    if (depth === 0) {
      start = match.index;
      tag = match[1] ?? "";
    }
    if (closing) depth -= 1;
    else if (!match[0].endsWith("/>")) depth += 1;
    if (depth === 0)
      children.push({
        tag,
        xml: xml.slice(start, match.index + match[0].length),
      });
  }
  if (depth !== 0) throw new Error("Unbalanced native paint properties");
  return children;
}

/** DrawingML has different child order for shapes, text runs and table cells. */
function replaceFill(
  xml: string,
  fill: string,
  owner: "shape" | "run" | "cell",
): string {
  const children = childrenOf(xml).filter((child) => {
    return ![
      "a:solidFill",
      "a:gradFill",
      "a:pattFill",
      "a:blipFill",
      "a:noFill",
      "a:grpFill",
    ].includes(child.tag);
  });
  const following =
    owner === "shape"
      ? [
          "a:ln",
          "a:effectLst",
          "a:effectDag",
          "a:scene3d",
          "a:sp3d",
          "a:extLst",
        ]
      : owner === "run"
        ? [
            "a:effectLst",
            "a:effectDag",
            "a:highlight",
            "a:uLnTx",
            "a:uLn",
            "a:uFillTx",
            "a:uFill",
            "a:latin",
            "a:ea",
            "a:cs",
            "a:sym",
            "a:hlinkClick",
            "a:hlinkMouseOver",
            "a:extLst",
          ]
        : ["a:headers", "a:extLst"];
  const before = children.findIndex((child) => {
    return following.includes(child.tag);
  });
  children.splice(before < 0 ? children.length : before, 0, {
    tag: "",
    xml: fill,
  });
  return children
    .map((child) => {
      return child.xml;
    })
    .join("");
}

/** Semantic paint keyed by the renderer's object identity, not approximate x/y. */
export function applyNativePaint(
  xml: string,
  paints: NativePaint[string] | undefined,
  scale: number,
): string {
  if (paints === undefined) return xml;
  const equations = new Map<number, string[]>();
  const output = xml.replace(
    /<p:(?:sp|pic|graphicFrame)\b[\s\S]*?<\/p:(?:sp|pic|graphicFrame)>/gu,
    (shape) => {
      const name = /<p:cNvPr\b[^>]*\bname="([^"]+)"/u.exec(shape)?.[1];
      const paint = name === undefined ? undefined : paints[name];
      if (paint === undefined) return shape;
      if (paint.mathGroup !== undefined) {
        const group = equations.get(paint.mathGroup);
        if (group) {
          group.push(shape);
          return "";
        }
        equations.set(paint.mathGroup, [shape]);
        return `<!--okou-equation:${paint.mathGroup.toString()}-->`;
      }
      let result = shape.replace(
        /<a:innerShdw\b([^>]*)>/u,
        (_match: string, attrs: string) => {
          const retained = [
            ...attrs.matchAll(/\b(?:blurRad|dist|dir)="[^"]*"/gu),
          ]
            .map((match) => {
              return match[0];
            })
            .join(" ");
          return `<a:innerShdw ${retained}>`;
        },
      );
      if (paint.fill) {
        const framed = radialFrame(result, paint.fill);
        result = framed.shape;
        const fill = fillXml(framed.fill);
        result = result.replace(
          /<p:spPr\b([^>]*)>([\s\S]*?)<\/p:spPr>/u,
          (_match: string, attributes: string, children: string) => {
            return `<p:spPr${attributes}>${replaceFill(children, fill, "shape")}</p:spPr>`;
          },
        );
      }
      if (paint.textFill || paint.textStroke || paint.noTextFill) {
        result = result.replace(
          /<a:rPr\b([^>]*)>([\s\S]*?)<\/a:rPr>/gu,
          (_match: string, attributes: string, children: string) => {
            let fixed = children;
            if (paint.textFill)
              fixed = replaceFill(fixed, fillXml(paint.textFill), "run");
            else if (paint.noTextFill)
              fixed = replaceFill(fixed, "<a:noFill/>", "run");
            if (paint.textStroke)
              fixed =
                `<a:ln w="${Math.round(paint.textStroke.width * scale)}"><a:solidFill>${colorXml(paint.textStroke)}</a:solidFill></a:ln>` +
                fixed.replace(/<a:ln\b[\s\S]*?<\/a:ln>/gu, "");
            return `<a:rPr${attributes}>${fixed}</a:rPr>`;
          },
        );
      }
      if (paint.grayscale || paint.crop)
        result = result.replace(/<a:blip\b([^>]*?)\/>/u, "<a:blip$1></a:blip>");
      if (paint.grayscale)
        result = result.replace(/(<a:blip\b[^>]*>)/u, "$1<a:grayscl/>");
      if (paint.crop) {
        const [left, top, right, bottom] = paint.crop;
        result = result
          .replace(/<a:srcRect\b[^>]*\/>/gu, "")
          .replace(
            "</a:blip>",
            `</a:blip><a:srcRect l="${Math.round(left * 100_000)}" t="${Math.round(top * 100_000)}" r="${Math.round(right * 100_000)}" b="${Math.round(bottom * 100_000)}"/>`,
          );
      }
      if (paint.cells) {
        let row = 0;
        result = result.replace(/<a:tr\b[\s\S]*?<\/a:tr>/gu, (text) => {
          const fills = paint.cells?.[row++];
          let cell = 0;
          return text.replace(/<a:tc\b[\s\S]*?<\/a:tc>/gu, (value) => {
            const fill = fills?.[cell++];
            if (!fill) return value;
            return value.replace(
              /<a:tcPr\b([^>]*)>([\s\S]*?)<\/a:tcPr>/u,
              (_match: string, attributes: string, children: string) => {
                return `<a:tcPr${attributes}>${replaceFill(children, fillXml(fill), "cell")}</a:tcPr>`;
              },
            );
          });
        });
      }
      return result;
    },
  );
  let nextId =
    Math.max(
      0,
      ...[...xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/gu)].map((match) => {
        return Number(match[1]);
      }),
    ) + 1;
  return output.replace(
    /<!--okou-equation:(\d+)-->/gu,
    (_match: string, key: string) => {
      const parts = equations.get(Number(key));
      if (!parts?.length)
        throw new Error("Native equation has no measured glyphs");
      const shapes = parts.join("");
      const frames = [
        ...shapes.matchAll(
          /<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/gu,
        ),
      ];
      if (!frames.length)
        throw new Error("Native equation has no coordinate frame");
      const x = Math.min(
          ...frames.map((f) => {
            return Number(f[1]);
          }),
        ),
        y = Math.min(
          ...frames.map((f) => {
            return Number(f[2]);
          }),
        );
      const w =
        Math.max(
          ...frames.map((f) => {
            return Number(f[1]) + Number(f[3]);
          }),
        ) - x;
      const h =
        Math.max(
          ...frames.map((f) => {
            return Number(f[2]) + Number(f[4]);
          }),
        ) - y;
      return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${nextId++}" name="okou-equation-${key}" descr="Editable MathML glyphs and rules"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/><a:chOff x="${x}" y="${y}"/><a:chExt cx="${w}" cy="${h}"/></a:xfrm></p:grpSpPr>${shapes}</p:grpSp>`;
    },
  );
}

/** Native paint/layout adapter installed in the same browser as the renderer. */
export const INSTALL_NATIVE = String.raw`
(selector) => {
  const state = window.__okouNative,
    roots = Array.from(document.querySelectorAll(selector));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const split = (value) => {
    const parts = [];
    let depth = 0,
      start = 0;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '(') depth++;
      if (value[i] === ')') depth--;
      if (value[i] === ',' && !depth) {
        parts.push(value.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(value.slice(start).trim());
    return parts;
  };
  const color = (value) => {
    if (!CSS.supports('color', value)) throw new Error('Unsupported CSS color');
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const p = context.getImageData(0, 0, 1, 1).data;
    return {
      color: Array.from(p.slice(0, 3))
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase(),
      alpha: p[3] / 255,
    };
  };
  const solid = (value) => ({ kind: 'solid', stops: [{ ...color(value), position: 0 }] });
  const diagnostic = (node, feature, reason) => {
    const meta = state.nodes.get(node),
      page = roots.findIndex((root) => root === node || root.contains(node)) + 1;
    if (
      !page ||
      state.diagnostics.some((x) => x.node === meta?.id && x.feature === feature && x.page === page)
    )
      return;
    const r = node.getBoundingClientRect(),
      root = roots[page - 1].getBoundingClientRect();
    state.diagnostics.push({
      page,
      tag: node.nodeName,
      images: 0,
      node: meta?.id ?? -1,
      feature,
      reason,
      box: { x: r.x - root.x, y: r.y - root.y, w: r.width, h: r.height },
    });
  };
  const clipStops = (stops) => {
    const sample = (position) => {
      let a = stops[0],
        b = stops.at(-1);
      for (let i = 0; i < stops.length; i++) {
        if (stops[i].position <= position + 1e-12) a = stops[i];
        else {
          b = stops[i];
          break;
        }
      }
      if (position < stops[0].position) return { ...stops[0], position };
      if (position >= stops.at(-1).position) return { ...stops.at(-1), position };
      if (Math.abs(a.position - position) < 1e-12) return { ...a, position };
      const t = (position - a.position) / Math.max(1e-9, b.position - a.position),
        alpha = a.alpha * (1 - t) + b.alpha * t;
      const c = [0, 2, 4]
        .map((i) =>
          Math.round(
            (parseInt(a.color.slice(i, i + 2), 16) * a.alpha * (1 - t) +
              parseInt(b.color.slice(i, i + 2), 16) * b.alpha * t) /
              Math.max(alpha, 1e-9),
          )
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')
        .toUpperCase();
      return { position, color: c, alpha };
    };
    return [sample(0), ...stops.filter((s) => s.position > 0 && s.position < 1), sample(1)];
  };
  const projectFill = (fill, source, target) => {
    if (fill?.kind === 'radial' && fill.radius)
      return {
        ...fill,
        center: [
          (source.x + fill.center[0] * source.w - target.x) / target.w,
          (source.y + fill.center[1] * source.h - target.y) / target.h,
        ],
        radius: [(fill.radius[0] * source.w) / target.w, (fill.radius[1] * source.h) / target.h],
      };
    if (fill?.kind !== 'linear') return fill;
    const angle = (fill.angle * Math.PI) / 180,
      dx = Math.cos(angle),
      dy = Math.sin(angle),
      full = Math.abs(dx) * source.w + Math.abs(dy) * source.h,
      length = Math.abs(dx) * target.w + Math.abs(dy) * target.h;
    if (!full || !length) return fill;
    const center =
        0.5 +
        ((target.x + target.w / 2 - source.x - source.w / 2) * dx +
          (target.y + target.h / 2 - source.y - source.h / 2) * dy) /
          full,
      start = center - length / full / 2;
    return {
      ...fill,
      stops: clipStops(
        fill.stops.map((s) => ({ ...s, position: ((s.position - start) * full) / length })),
      ),
    };
  };
  const gradient = (value, w, h, node) => {
    const match = /^(repeating-)?(linear|radial)-gradient\((.*)\)$/.exec(value);
    if (!match) {
      diagnostic(
        node,
        'background-image',
        'This CSS paint has no equivalent implemented native fill',
      );
      return null;
    }
    let args = split(match[3]),
      angle = 180,
      center = [0.5, 0.5],
      length = h,
      radius;
    const kind = match[2];
    const head = args[0];
    if (
      !/^([a-z]+\(|#[0-9a-f]|[a-z]+(?:\s|$))/i.test(head) ||
      /^(to |[-.\d]|circle|ellipse|closest|farthest|at )/.test(head)
    ) {
      args.shift();
      if (kind === 'linear') {
        if (head.startsWith('to ')) {
          const x = head.includes('right') ? 1 : head.includes('left') ? -1 : 0,
            y = head.includes('bottom') ? 1 : head.includes('top') ? -1 : 0;
          angle = (Math.atan2(x, -y) * 180) / Math.PI;
        } else {
          angle = parseFloat(head);
          if (head.endsWith('turn')) angle *= 360;
          else if (head.endsWith('rad')) angle *= 180 / Math.PI;
        }
      } else {
        const at = /at\s+(.*)/.exec(head);
        if (at) {
          let parts = at[1].trim().split(/\s+/);
          if (['top', 'bottom'].includes(parts[0])) parts.reverse();
          const position = (v, total) =>
            ({ left: 0, top: 0, center: 0.5, right: 1, bottom: 1 })[v] ??
            (v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v) / total);
          center = [position(parts[0], w), position(parts[1] || 'center', h)];
          if (center.some((v) => !Number.isFinite(v))) {
            diagnostic(node, 'radial-gradient-position', 'Unsupported radial center syntax');
            return null;
          }
        }
      }
    }
    if (kind === 'linear')
      length =
        Math.abs(Math.sin((angle * Math.PI) / 180)) * w +
        Math.abs(Math.cos((angle * Math.PI) / 180)) * h;
    if (kind === 'radial') {
      const extent = head.replace(/(?:^|\s)at\s.*$/, ''),
        cx = center[0] * w,
        cy = center[1] * h;
      const nearX = Math.min(Math.abs(cx), Math.abs(w - cx)),
        farX = Math.max(Math.abs(cx), Math.abs(w - cx)),
        nearY = Math.min(Math.abs(cy), Math.abs(h - cy)),
        farY = Math.max(Math.abs(cy), Math.abs(h - cy));
      const closest = extent.includes('closest'),
        corner = !extent.includes('side'),
        circle = extent.includes('circle');
      const x = closest ? nearX : farX,
        y = closest ? nearY : farY;
      let rx, ry;
      const explicit = extent.match(/(?:^|\s)([\d.]+)(px|%)/g);
      if (explicit) {
        const value = (v, total) =>
          v.trim().endsWith('%') ? (parseFloat(v) * total) / 100 : parseFloat(v);
        rx = value(explicit[0], w);
        ry = explicit[1] ? value(explicit[1], h) : rx;
      } else if (circle) {
        rx = ry = corner ? Math.hypot(x, y) : closest ? Math.min(x, y) : Math.max(x, y);
      } else {
        rx = x * (corner ? Math.SQRT2 : 1);
        ry = y * (corner ? Math.SQRT2 : 1);
      }
      if (!(rx > 0 && ry > 0)) {
        diagnostic(node, 'radial-gradient-extent', 'Degenerate radial gradient extent');
        return null;
      }
      radius = [rx / w, ry / h];
      length = rx;
    }
    const stops = [];
    for (const arg of args) {
      const m = /^(rgba?\([^)]*\)|#[\da-f]+|[a-z]+)(.*)$/i.exec(arg);
      if (!m) {
        diagnostic(node, 'gradient-color', 'Unmapped gradient color syntax');
        return null;
      }
      const c = color(m[1]);
      const positions = m[2].trim().split(/\s+/).filter(Boolean);
      if (!positions.length) stops.push({ ...c, position: null });
      else
        for (const p of positions)
          stops.push({
            ...c,
            position: p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / Math.max(1, length),
          });
    }
    if (stops.length < 2) return null;
    if (stops[0].position === null) stops[0].position = 0;
    if (stops.at(-1).position === null) stops.at(-1).position = 1;
    for (let i = 0; i < stops.length;) {
      let j = i + 1;
      while (j < stops.length && stops[j].position === null) j++;
      if (j >= stops.length) break;
      stops[j].position = Math.max(stops[i].position, stops[j].position);
      for (let k = i + 1; k < j; k++)
        stops[k].position =
          stops[i].position + ((stops[j].position - stops[i].position) * (k - i)) / (j - i);
      i = j;
    }
    let expanded = stops;
    if (match[1]) {
      const period = stops.at(-1).position - stops[0].position;
      if (period <= 0) return solid(args.at(-1).split(' ')[0]);
      if ((1 / period) * stops.length > 512) {
        diagnostic(node, 'repeating-gradient-density', 'Native gradient would exceed 512 stops');
        return null;
      }
      expanded = [];
      for (
        let n = Math.floor(-stops.at(-1).position / period);
        n <= Math.ceil((1 - stops[0].position) / period);
        n++
      )
        for (const stop of stops) expanded.push({ ...stop, position: stop.position + n * period });
    }
    const clipped = clipStops(expanded);
    for (let i = 0; i < clipped.length; i++) {
      if (clipped[i].alpha !== 0) continue;
      const neighbor =
        clipped
          .slice(0, i)
          .reverse()
          .find((s) => s.alpha > 0) || clipped.slice(i + 1).find((s) => s.alpha > 0);
      if (neighbor) clipped[i].color = neighbor.color;
    }
    return { kind, angle: (((angle - 90) % 360) + 360) % 360, center, radius, stops: clipped };
  };
  const dimensions = (node) => {
    const s = getComputedStyle(node),
      r = node.getBoundingClientRect();
    let w = parseFloat(s.width),
      h = parseFloat(s.height);
    if (s.boxSizing !== 'border-box') {
      w +=
        parseFloat(s.paddingLeft) +
        parseFloat(s.paddingRight) +
        parseFloat(s.borderLeftWidth) +
        parseFloat(s.borderRightWidth);
      h +=
        parseFloat(s.paddingTop) +
        parseFloat(s.paddingBottom) +
        parseFloat(s.borderTopWidth) +
        parseFloat(s.borderBottomWidth);
    }
    return {
      w: Math.max(
        Number.isFinite(w) ? w : r.width,
        parseFloat(s.borderLeftWidth) + parseFloat(s.borderRightWidth),
      ),
      h: Math.max(
        Number.isFinite(h) ? h : r.height,
        parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth),
      ),
    };
  };
  const geometry = (node) => {
    const rect = node.getBoundingClientRect(),
      { w, h } = dimensions(node);
    let matrix = new DOMMatrix();
    for (let el = node; el; el = el.parentElement) {
      const t = getComputedStyle(el).transform;
      if (t !== 'none') matrix = new DOMMatrix(t).multiply(matrix);
      if (roots.includes(el)) break;
    }
    const sx = Math.hypot(matrix.a, matrix.b),
      sy = Math.hypot(matrix.c, matrix.d),
      rotation = (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
    const similarity =
      matrix.is2D &&
      Math.abs(sx - sy) < 0.0001 &&
      Math.abs(matrix.a * matrix.c + matrix.b * matrix.d) < 0.0001;
    if (!matrix.is2D)
      diagnostic(
        node,
        'perspective',
        'Native editable perspective text and 3D transforms are not implemented',
      );
    return {
      rect,
      w,
      h,
      matrix,
      sx,
      sy,
      rotation,
      similarity,
      x: rect.x + rect.width / 2 - (w * sx) / 2,
      y: rect.y + rect.height / 2 - (h * sy) / 2,
    };
  };
  state.geometry = geometry;
  state.diagnostic = diagnostic;
  const polygon = (points, clip) => {
    const area = clip.reduce((sum, p, i) => {
      const q = clip[(i + 1) % clip.length];
      return sum + p.x * q.y - q.x * p.y;
    }, 0);
    if (area < 0) clip = [...clip].reverse();
    let out = points;
    for (let i = 0; i < clip.length; i++) {
      const a = clip[i],
        b = clip[(i + 1) % clip.length],
        inside = (p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= -0.001;
      const input = out;
      out = [];
      for (let j = 0; j < input.length; j++) {
        const p = input[j],
          q = input[(j + 1) % input.length],
          pin = inside(p),
          qin = inside(q);
        if (pin) out.push(p);
        if (pin !== qin) {
          const dx = q.x - p.x,
            dy = q.y - p.y,
            den = dx * (b.y - a.y) - dy * (b.x - a.x);
          if (Math.abs(den) > 1e-9) {
            const t = ((a.x - p.x) * (b.y - a.y) - (a.y - p.y) * (b.x - a.x)) / den;
            out.push({ x: p.x + t * dx, y: p.y + t * dy });
          }
        }
      }
      if (!out.length) break;
    }
    return out;
  };
  const rounded = (w, h, s) => {
    const corners = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map((name) => {
      const v = s['border' + name + 'Radius'].split(' ');
      return [
        v[0].endsWith('%') ? (parseFloat(v[0]) * w) / 100 : parseFloat(v[0]),
        (v[1] || v[0]).endsWith('%')
          ? (parseFloat(v[1] || v[0]) * h) / 100
          : parseFloat(v[1] || v[0]),
      ];
    });
    const factor = Math.min(
      1,
      w / Math.max(1, corners[0][0] + corners[1][0]),
      w / Math.max(1, corners[3][0] + corners[2][0]),
      h / Math.max(1, corners[0][1] + corners[3][1]),
      h / Math.max(1, corners[1][1] + corners[2][1]),
    );
    for (const c of corners) {
      c[0] *= factor;
      c[1] *= factor;
    }
    const points = [];
    const centers = [
      [corners[0][0], corners[0][1]],
      [w - corners[1][0], corners[1][1]],
      [w - corners[2][0], h - corners[2][1]],
      [corners[3][0], h - corners[3][1]],
    ];
    for (let corner = 0; corner < 4; corner++)
      for (let step = 0; step <= 12; step++) {
        const angle = ((-180 + corner * 90 + (step * 90) / 12) * Math.PI) / 180;
        const start = ((-180 + corner * 90) * Math.PI) / 180;
        const k = (4 * (Math.sqrt(2) - 1)) / 3;
        const [cx, cy] = centers[corner],
          [rx, ry] = corners[corner];
        points.push({
          x: cx + Math.cos(angle) * rx,
          y: cy + Math.sin(angle) * ry,
          intermediate: step > 0 && step < 12,
          ...(step === 12
            ? {
                curve: {
                  x1: cx + (Math.cos(start) - k * Math.sin(start)) * rx,
                  y1: cy + (Math.sin(start) + k * Math.cos(start)) * ry,
                  x2: cx + (Math.cos(angle) + k * Math.sin(angle)) * rx,
                  y2: cy + (Math.sin(angle) - k * Math.cos(angle)) * ry,
                },
              }
            : {}),
        });
      }
    return points;
  };
  const outline = (node, g, s) => {
    let points = rounded(g.w, g.h, s);
    const clip = s.clipPath;
    if (clip.startsWith('polygon(')) {
      const p = split(clip.slice(8, -1))
        .map((value) => value.split(/\s+/))
        .filter((v) => v.length === 2)
        .map(([x, y]) => ({
          x: x.endsWith('%') ? (parseFloat(x) * g.w) / 100 : parseFloat(x),
          y: y.endsWith('%') ? (parseFloat(y) * g.h) / 100 : parseFloat(y),
        }));
      if (p.length >= 3) points = polygon(points, p);
    } else if (clip.startsWith('circle(') || clip.startsWith('ellipse(')) {
      const m = /^(circle|ellipse)\((.*?)\)/.exec(clip),
        parts = m[2].split(' at '),
        radii = parts[0].trim().split(/\s+/);
      const radius = (v, size) => (v?.endsWith('%') ? (parseFloat(v) * size) / 100 : parseFloat(v));
      const rx =
          radius(radii[0], m[1] === 'circle' ? Math.hypot(g.w, g.h) / Math.SQRT2 : g.w) ||
          Math.min(g.w, g.h) / 2,
        ry = m[1] === 'circle' ? rx : radius(radii[1], g.h) || g.h / 2;
      const center = (parts[1] || '50% 50%').split(' ');
      const cx = radius(center[0], g.w),
        cy = radius(center[1], g.h);
      points = Array.from({ length: 96 }, (_, i) => ({
        x: cx + rx * Math.cos((i * 2 * Math.PI) / 96),
        y: cy + ry * Math.sin((i * 2 * Math.PI) / 96),
      }));
    } else if (clip !== 'none')
      diagnostic(node, 'clip-path', 'This clip-path syntax has no implemented native geometry');
    return points;
  };
  const world = (p, g) => ({
    ...p,
    ...(p.curve
      ? {
          curve: {
            x1: world({ x: p.curve.x1, y: p.curve.y1 }, g).x,
            y1: world({ x: p.curve.x1, y: p.curve.y1 }, g).y,
            x2: world({ x: p.curve.x2, y: p.curve.y2 }, g).x,
            y2: world({ x: p.curve.x2, y: p.curve.y2 }, g).y,
          },
        }
      : {}),
    x: g.rect.x + g.rect.width / 2 + g.matrix.a * (p.x - g.w / 2) + g.matrix.c * (p.y - g.h / 2),
    y: g.rect.y + g.rect.height / 2 + g.matrix.b * (p.x - g.w / 2) + g.matrix.d * (p.y - g.h / 2),
  });
  const clipped = (points, node) => {
    let out = points;
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const s = getComputedStyle(ancestor);
      if (
        ['hidden', 'clip', 'scroll', 'auto'].includes(s.overflowX) ||
        ['hidden', 'clip', 'scroll', 'auto'].includes(s.overflowY)
      ) {
        const g = geometry(ancestor);
        out = polygon(
          out,
          rounded(g.w, g.h, s).map((p) => world(p, g)),
        );
      }
      if (roots.includes(ancestor)) break;
    }
    return out;
  };
  const shape = (node, points, fill, config, extra = {}) => {
    const p = clipped(points, node);
    if (p.length < 3) return null;
    const minX = Math.min(...p.map((p) => p.x)),
      minY = Math.min(...p.map((p) => p.y)),
      w = Math.max(...p.map((p) => p.x)) - minX,
      h = Math.max(...p.map((p) => p.y)) - minY;
    if (w < 0.01 || h < 0.01) return null;
    const unit = config.scale / 96;
    const exact = p.length === points.length && p.every((point) => points.includes(point));
    const path = exact ? p.filter((point) => !point.intermediate) : p;
    return {
      type: 'shape',
      shapeType: 'custGeom',
      _nativePaint: fill
        ? {
            fill: projectFill(
              fill,
              {
                x: Math.min(...points.map((p) => p.x)),
                y: Math.min(...points.map((p) => p.y)),
                w: Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x)),
                h: Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y)),
              },
              { x: minX, y: minY, w, h },
            ),
          }
        : undefined,
      options: {
        x: config.offX + (minX - config.rootX) * unit,
        y: config.offY + (minY - config.rootY) * unit,
        w: w * unit,
        h: h * unit,
        points: [
          ...path.map((v) => ({
            x: (v.x - minX) * unit,
            y: (v.y - minY) * unit,
            ...(exact && v.curve
              ? {
                  curve: {
                    type: 'cubic',
                    x1: (v.curve.x1 - minX) * unit,
                    y1: (v.curve.y1 - minY) * unit,
                    x2: (v.curve.x2 - minX) * unit,
                    y2: (v.curve.y2 - minY) * unit,
                  },
                }
              : {}),
          })),
          { close: true },
        ],
        fill: fill
          ? { color: fill.stops[0].color, transparency: (1 - fill.stops[0].alpha) * 100 }
          : undefined,
        line: { transparency: 100 },
        ...extra,
      },
    };
  };
  const font = (s, config) => ({
    fontFace: s.fontFamily
      .split(',')[0]
      .trim()
      .replace(/^['"]|['"]$/g, ''),
    fontSize: parseFloat(s.fontSize) * 0.75 * config.scale,
    bold: Number(s.fontWeight) >= 600,
    italic: s.fontStyle === 'italic',
    color: color(s.color).color,
    transparency: (1 - color(s.color).alpha) * 100,
    underline: s.textDecorationLine.includes('underline') ? { style: 'sng' } : { style: 'none' },
  });
  const sourceImage = async (src) => {
    if (src.startsWith('file:')) {
      // Decode only the original asset. No DOM or CSS enters this canvas.
      const image = await new Promise((resolve, reject) => {
        const value = new Image();
        value.onload = () => resolve(value);
        value.onerror = () => reject(new Error('Source image could not be loaded'));
        value.src = src;
      });
      const asset = document.createElement('canvas');
      asset.width = image.naturalWidth;
      asset.height = image.naturalHeight;
      asset.getContext('2d').drawImage(image, 0, 0);
      return asset.toDataURL('image/png');
    }
    const response = await fetch(src);
    if (!response.ok) throw new Error('Source background image is unavailable');
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };
  const imageSize = (src) =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
      image.onerror = reject;
      image.src = src;
    });
  const mathGlyphs = (node, config, key) => {
    const items = [],
      unit = config.scale / 96,
      root = { x: config.rootX, y: config.rootY };
    const addText = (text, r, s, element) => {
      const fontFamily = state.nodes.get(element).fontFamily;
      if (!fontFamily) throw new Error('Browser did not resolve the equation glyph font');
      items.push({
        type: 'text',
        _nativePaint: { mathGroup: key },
        textParts: [
          {
            text,
            options: {
              ...font(s, config),
              fontFace: fontFamily,
            },
          },
        ],
        options: {
          x: config.offX + (r.x - root.x) * unit,
          y: config.offY + (r.y - root.y) * unit,
          w: r.width * unit,
          h: r.height * unit,
          margin: 0,
          wrap: false,
        },
      });
    };
    for (const leaf of node.querySelectorAll('mi,mn,mo,mtext')) {
      const range = document.createRange();
      range.selectNodeContents(leaf);
      const r = range.getBoundingClientRect();
      const style = getComputedStyle(leaf);
      let text = leaf.textContent;
      if (style.textTransform === 'math-auto' && /^[a-zA-Z]$/.test(text)) {
        const code = text.codePointAt(0);
        text = String.fromCodePoint(
          text === 'h' ? 0x210e : code >= 97 ? 0x1d44e + code - 97 : 0x1d434 + code - 65,
        );
      }
      if (r.width && r.height && text.trim()) addText(text, r, style, leaf);
    }
    const line = (x, y, w, s) => {
      const thickness = Math.max(1, parseFloat(s.fontSize) * 0.045),
        c = color(s.color);
      const item = shape(
        node,
        [
          { x, y },
          { x: x + w, y },
          { x: x + w, y: y + thickness },
          { x, y: y + thickness },
        ],
        { kind: 'solid', stops: [{ ...c, position: 0 }] },
        config,
      );
      if (item) {
        item._nativePaint = { mathGroup: key };
        items.push(item);
      }
    };
    for (const fraction of node.querySelectorAll('mfrac')) {
      const num = fraction.children[0].getBoundingClientRect(),
        den = fraction.children[1].getBoundingClientRect(),
        r = fraction.getBoundingClientRect();
      line(r.x, (num.bottom + den.top) / 2, r.width, getComputedStyle(fraction));
    }
    for (const radical of node.querySelectorAll('msqrt,mroot')) {
      const r = radical.getBoundingClientRect(),
        content = radical.children[0].getBoundingClientRect(),
        s = getComputedStyle(radical);
      const width = Math.max(1, content.x - r.x),
        thickness = Math.max(1, parseFloat(s.fontSize) * 0.045);
      const points = [
        { x: r.x, y: r.y + r.height * 0.6 },
        { x: r.x + width * 0.22, y: r.y + r.height * 0.48 },
        { x: r.x + width * 0.45, y: r.bottom - thickness },
        { x: content.x, y: r.y + thickness / 2 },
        { x: r.right, y: r.y + thickness / 2 },
      ];
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i],
          b = points[i + 1],
          length = Math.hypot(b.x - a.x, b.y - a.y),
          dx = (-(b.y - a.y) * thickness) / (2 * length),
          dy = ((b.x - a.x) * thickness) / (2 * length);
        const item = shape(
          node,
          [
            { x: a.x + dx, y: a.y + dy },
            { x: b.x + dx, y: b.y + dy },
            { x: b.x - dx, y: b.y - dy },
            { x: a.x - dx, y: a.y - dy },
          ],
          solid(s.color),
          config,
        );
        if (item) {
          item._nativePaint = { mathGroup: key };
          items.push(item);
        }
      }
    }
    return items;
  };
  window.__okouNativeRender = (node, result, config, pptx, options) => {
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element) return result;
    let owner = element;
    while (owner && !state.nodes.has(owner)) owner = owner.parentElement;
    if (!owner) throw new Error('Native renderer object has no measured source identity');
    const meta = state.nodes.get(owner);
    const annotate = (items) => {
      for (const item of items) {
        item._paintOrder ??= meta.order;
        item._paintPhase ??= item.type === 'text' ? 2 : 0;
        item._sourceId = meta.id;
        item.domOrder ??= result?.items?.[0]?.domOrder ?? meta.id;
        item.zIndex ??= [0];
      }
      return items;
    };
    if (node.nodeType !== 1) {
      if (result) annotate(result.items || []);
      return result;
    }
    const s = getComputedStyle(node),
      g = geometry(node),
      items = [];
    const add = (item) => {
      if (item) items.push(item);
    };
    const alpha = Number(s.opacity) * (options._inheritedOpacity ?? 1);
    if (s.display === 'none' || s.visibility !== 'visible' || alpha === 0) return result;
    for (const [property, feature] of [
      ['backdropFilter', 'backdrop-filter'],
      ['mixBlendMode', 'mix-blend-mode'],
    ])
      if (!['none', 'normal'].includes(s[property]))
        diagnostic(
          node,
          feature,
          'This compositing effect has no verified editable native equivalent',
        );
    if (Number(s.opacity) < 1 && node.children.length > 0)
      diagnostic(
        node,
        'group-opacity',
        'Overlapping descendants require group compositing; per-object alpha is not equivalent',
      );
    if (node.localName === 'math') {
      const supported = new Set([
        'math',
        'mrow',
        'semantics',
        'annotation',
        'mi',
        'mn',
        'mo',
        'mtext',
        'mfrac',
        'msqrt',
        'mroot',
        'msub',
        'msup',
        'msubsup',
      ]);
      const unsupported = [...node.querySelectorAll('*')].filter(
        (element) => !supported.has(element.localName),
      );
      if (unsupported.length)
        diagnostic(
          node,
          'mathml',
          'Unimplemented MathML structures: ' +
            [...new Set(unsupported.map((element) => element.localName))].join(', '),
        );
      diagnostic(
        node,
        'math-semantic-editing',
        'Equation uses editable glyphs and rules; semantic OfficeMath editing is not implemented',
      );
      return { items: annotate(mathGlyphs(node, config, meta.id)), stopRecursion: true };
    }
    const media = ['img', 'svg', 'canvas', 'video'].includes(node.localName);
    if (s.filter !== 'none' && !media)
      diagnostic(
        node,
        'filter-compositing',
        'This filter requires a composited native effect on the entire subtree',
      );
    const jobs = [];
    const original = (result?.items || []).filter(
      (item) => item.type === 'text' || item.type === 'table' || (item.type === 'image' && media),
    );
    const textPaint = node.__okouTextPaint || s;
    const paintedText =
      textPaint.backgroundClip === 'text' || textPaint.webkitBackgroundClip === 'text';
    let paints = split(s.backgroundImage).filter((v) => v !== 'none' && !v.startsWith('url('));
    if (paintedText) paints = [];
    const background = color(s.backgroundColor);
    if (background.alpha > 0 && !paintedText)
      add(
        shape(
          node,
          outline(node, g, s).map((p) => world(p, g)),
          {
            kind: 'solid',
            stops: [{ ...background, alpha: background.alpha * alpha, position: 0 }],
          },
          config,
        ),
      );
    for (const value of paints.reverse()) {
      const fill = gradient(value, g.w, g.h, node);
      if (fill) {
        fill.stops.forEach((stop) => (stop.alpha *= alpha));
        add(
          shape(
            node,
            outline(node, g, s).map((p) => world(p, g)),
            fill,
            config,
          ),
        );
      }
    }
    if (roots.includes(node) && background.alpha === 0 && s.backgroundImage === 'none') {
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const a = getComputedStyle(ancestor);
        if (a.backgroundImage !== 'none') {
          const ar = ancestor.getBoundingClientRect(),
            fill = gradient(a.backgroundImage, ar.width, ar.height, node);
          if (fill)
            add(
              shape(
                node,
                outline(node, g, s).map((p) => world(p, g)),
                projectFill(
                  fill,
                  { x: ar.x, y: ar.y, w: ar.width, h: ar.height },
                  { x: g.rect.x, y: g.rect.y, w: g.w, h: g.h },
                ),
                config,
              ),
            );
          break;
        }
      }
    }
    const urls = split(s.backgroundImage).filter((value) => value.startsWith('url('));
    if (urls.length) {
      if (paints.length)
        diagnostic(
          node,
          'mixed-background-layers',
          'Mixed image and gradient layers need an ordered native background stack',
        );
      if (urls.length > 1 || s.transform !== 'none')
        diagnostic(
          node,
          'background-image-layers',
          'Multiple or transformed image backgrounds require additional native picture geometry',
        );
      const url = urls[0].slice(4, -1).replace(/^['"]|['"]$/g, ''),
        unit = config.scale / 96;
      const tiles = [];
      jobs.push(async () => {
        const [iw, ih] = await imageSize(url),
          data = await sourceImage(url),
          size = s.backgroundSize.split(' ');
        let tw = iw,
          th = ih;
        const dimension = (v, total) =>
          v.endsWith('%') ? (parseFloat(v) * total) / 100 : parseFloat(v);
        if (['cover', 'contain'].includes(size[0])) {
          const factor = (size[0] === 'cover' ? Math.max : Math.min)(g.w / iw, g.h / ih);
          tw = iw * factor;
          th = ih * factor;
        } else if (size[0] !== 'auto') {
          tw = dimension(size[0], g.w);
          th = size[1] && size[1] !== 'auto' ? dimension(size[1], g.h) : (tw * ih) / iw;
        } else if (size[1] && size[1] !== 'auto') {
          th = dimension(size[1], g.h);
          tw = (th * iw) / ih;
        }
        if (!(tw > 0 && th > 0)) throw new Error('Invalid native background image dimensions');
        const position = s.backgroundPosition.split(' '),
          offset = (v, available) =>
            v.endsWith('%') ? (parseFloat(v) * available) / 100 : parseFloat(v) || 0;
        const ox = offset(position[0], g.w - tw),
          oy = offset(position[1] || '50%', g.h - th),
          repeat = s.backgroundRepeat;
        const rx = repeat === 'repeat' || repeat === 'repeat-x' || repeat.startsWith('repeat '),
          ry = repeat === 'repeat' || repeat === 'repeat-y' || repeat.endsWith(' repeat');
        if (/space|round/.test(repeat))
          diagnostic(node, 'background-repeat', 'Space and round image tiling are not implemented');
        const xs = rx ? Math.floor(-ox / tw) : 0,
          xe = rx ? Math.ceil((g.w - ox) / tw) : 1,
          ys = ry ? Math.floor(-oy / th) : 0,
          ye = ry ? Math.ceil((g.h - oy) / th) : 1;
        if ((xe - xs) * (ye - ys) > 2048)
          throw new Error('Native background exceeds 2048 source-image tiles');
        for (let yi = ys; yi < ye; yi++)
          for (let xi = xs; xi < xe; xi++) {
            const x = ox + xi * tw,
              y = oy + yi * th,
              l = Math.max(0, x),
              t = Math.max(0, y),
              r = Math.min(g.w, x + tw),
              b = Math.min(g.h, y + th);
            if (r <= l || b <= t) continue;
            const item = {
              type: 'image',
              sourceImage: true,
              _paintOrder: meta.order,
              _paintPhase: 0,
              _sourceId: meta.id,
              zIndex: [0],
              domOrder: result?.items?.[0]?.domOrder ?? 0,
              _nativePaint: {
                crop: [(l - x) / tw, (t - y) / th, (x + tw - r) / tw, (y + th - b) / th],
              },
              options: {
                data,
                x: config.offX + (g.rect.x + l - config.rootX) * unit,
                y: config.offY + (g.rect.y + t - config.rootY) * unit,
                w: (r - l) * unit,
                h: (b - t) * unit,
                transparency: (1 - alpha) * 100,
              },
            };
            tiles.push(item);
          }
      });
      // The queue must own placeholders before async source decoding runs.
      const placeholder = { type: 'shape', shapeType: 'rect', skip: true, options: {} };
      add(placeholder);
      jobs.push(async () => {
        const queue = state.queue;
        if (!queue) throw new Error('Native background queue is missing');
        queue.push(...tiles);
      });
    }
    const borders = ['Top', 'Right', 'Bottom', 'Left'].map((side) => ({
      side,
      width: parseFloat(s['border' + side + 'Width']),
      style: s['border' + side + 'Style'],
      color: color(s['border' + side + 'Color']),
    }));
    const b = borders.map((b) => b.width);
    const uniformBorder =
      s.clipPath === 'none' &&
      b[0] > 0 &&
      borders.every(
        (border) =>
          border.width === b[0] &&
          border.style === 'solid' &&
          border.color.color === borders[0].color.color &&
          border.color.alpha === borders[0].color.alpha,
      );
    if (uniformBorder) {
      const half = b[0] / 2,
        style = {};
      for (const corner of ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft']) {
        const raw = s['border' + corner + 'Radius'].split(' ');
        const values = [raw[0], raw[1] || raw[0]];
        style['border' + corner + 'Radius'] = values
          .map(
            (v, i) =>
              Math.max(
                0,
                (v.endsWith('%') ? (parseFloat(v) * (i ? g.h : g.w)) / 100 : parseFloat(v)) - half,
              ) + 'px',
          )
          .join(' ');
      }
      add(
        shape(
          node,
          rounded(g.w - b[0], g.h - b[0], style).map((p) =>
            world(
              {
                ...p,
                x: p.x + half,
                y: p.y + half,
                ...(p.curve
                  ? {
                      curve: {
                        x1: p.curve.x1 + half,
                        y1: p.curve.y1 + half,
                        x2: p.curve.x2 + half,
                        y2: p.curve.y2 + half,
                      },
                    }
                  : {}),
              },
              g,
            ),
          ),
          null,
          config,
          {
            line: {
              color: borders[0].color.color,
              transparency: (1 - borders[0].color.alpha * alpha) * 100,
              width: b[0] * 0.75 * config.scale,
            },
          },
        ),
      );
    }
    const corners = [
      [
        { x: 0, y: 0 },
        { x: g.w, y: 0 },
        { x: g.w - b[1], y: b[0] },
        { x: b[3], y: b[0] },
      ],
      [
        { x: g.w, y: 0 },
        { x: g.w, y: g.h },
        { x: g.w - b[1], y: g.h - b[2] },
        { x: g.w - b[1], y: b[0] },
      ],
      [
        { x: g.w, y: g.h },
        { x: 0, y: g.h },
        { x: b[3], y: g.h - b[2] },
        { x: g.w - b[1], y: g.h - b[2] },
      ],
      [
        { x: 0, y: g.h },
        { x: 0, y: 0 },
        { x: b[3], y: b[0] },
        { x: b[3], y: g.h - b[2] },
      ],
    ];
    for (let i = 0; i < 4 && !uniformBorder; i++) {
      const border = borders[i];
      if (!['none', 'hidden', 'solid', 'dashed', 'dotted', 'double'].includes(border.style))
        diagnostic(
          node,
          'border-style',
          'This border lighting style has no verified native path equivalent',
        );
      if (!border.width || !border.color.alpha || border.style === 'none') continue;
      const fill = {
        kind: 'solid',
        stops: [{ ...border.color, alpha: border.color.alpha * alpha, position: 0 }],
      };
      if (['dotted', 'dashed'].includes(border.style)) {
        const horizontal = i % 2 === 0,
          length = horizontal ? g.w : g.h;
        const dash = border.width * (border.style === 'dotted' ? 1 : 3),
          gap = border.width;
        for (let p = 0; p < length; p += dash + gap) {
          const end = Math.min(length, p + dash),
            x = horizontal ? p : i === 1 ? g.w - border.width : 0,
            y = horizontal ? (i === 2 ? g.h - border.width : 0) : p,
            w = horizontal ? end - p : border.width,
            h = horizontal ? border.width : end - p;
          add(
            shape(
              node,
              (border.style === 'dotted'
                ? Array.from({ length: 24 }, (_, i) => ({
                    x: x + w / 2 + (Math.cos((i * Math.PI) / 12) * w) / 2,
                    y: y + h / 2 + (Math.sin((i * Math.PI) / 12) * h) / 2,
                  }))
                : [
                    { x, y },
                    { x: x + w, y },
                    { x: x + w, y: y + h },
                    { x, y: y + h },
                  ]
              ).map((p) => world(p, g)),
              fill,
              config,
            ),
          );
        }
      } else if (border.style === 'double') {
        const p = corners[i];
        for (const [a, z] of [
          [0, 1 / 3],
          [2 / 3, 1],
        ]) {
          const lerp = (u, v, t) => ({ x: u.x + (v.x - u.x) * t, y: u.y + (v.y - u.y) * t });
          add(
            shape(
              node,
              [
                lerp(p[0], p[3], a),
                lerp(p[1], p[2], a),
                lerp(p[1], p[2], z),
                lerp(p[0], p[3], z),
              ].map((p) => world(p, g)),
              fill,
              config,
            ),
          );
        }
      } else
        add(
          shape(
            node,
            polygon(corners[i], outline(node, g, s)).map((p) => world(p, g)),
            fill,
            config,
          ),
        );
    }
    if (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) {
      const width = parseFloat(s.outlineWidth),
        offset = parseFloat(s.outlineOffset) || 0,
        c = color(s.outlineColor),
        o = offset + width;
      const fill = { kind: 'solid', stops: [{ ...c, position: 0 }] };
      for (const p of [
        [
          [-o, -o],
          [g.w + o, -o],
          [g.w + o, -offset],
          [-o, -offset],
        ],
        [
          [-o, g.h + offset],
          [g.w + o, g.h + offset],
          [g.w + o, g.h + o],
          [-o, g.h + o],
        ],
        [
          [-o, -offset],
          [-offset, -offset],
          [-offset, g.h + offset],
          [-o, g.h + offset],
        ],
        [
          [g.w + offset, -offset],
          [g.w + o, -offset],
          [g.w + o, g.h + offset],
          [g.w + offset, g.h + offset],
        ],
      ])
        add(
          shape(
            node,
            p.map(([x, y]) => world({ x, y }, g)),
            fill,
            config,
          ),
        );
    }
    const shadow = (value) => {
      if (value === 'none') return undefined;
      const layers = split(value);
      const m =
        /^(rgba?\([^)]*\)|#[\da-f]+)\s+(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+([\d.]+)px)?(?:\s+(-?[\d.]+)px)?(?:\s+(inset))?$/.exec(
          layers[0],
        );
      if (layers.length !== 1 || !m || Number(m[5] || 0) !== 0) {
        diagnostic(
          node,
          'shadow',
          'Multiple shadow layers or spread require additional native geometry',
        );
        return undefined;
      }
      const c = color(m[1]),
        x = Number(m[2]),
        y = Number(m[3]);
      return {
        type: m[6] ? 'inner' : 'outer',
        angle: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360,
        offset: Math.hypot(x, y) * 0.75 * config.scale,
        blur: Number(m[4] || 0) * 0.75 * config.scale,
        color: c.color,
        opacity: c.alpha * alpha,
      };
    };
    const boxShadow = shadow(s.boxShadow);
    if (boxShadow && background.alpha === 0 && !paints.length)
      diagnostic(
        node,
        'shadow-silhouette',
        'A transparent box shadow needs an independent native silhouette',
      );
    else if (boxShadow && items[0]) items[0].options.shadow = boxShadow;
    const textShadow = shadow(s.textShadow);
    for (const item of original) {
      if (item.type === 'text') {
        delete item.options.fill;
        item.options.line = { transparency: 100 };
        delete item.options.shadow;
        if (textShadow) item.options.shadow = textShadow;
        if (g.similarity) {
          const unit = config.scale / 96;
          item.options.x = config.offX + (g.x - config.rootX) * unit;
          item.options.y = config.offY + (g.y - config.rootY) * unit;
          item.options.w = g.w * g.sx * unit;
          item.options.h = g.h * g.sy * unit;
          item.options.rotate = g.rotation;
          for (const part of item.textParts || []) {
            if (part.options?.fontSize) part.options.fontSize *= g.sx;
            if (part.options?.lineSpacing) part.options.lineSpacing *= g.sx;
          }
          if (Array.isArray(item.options.margin))
            item.options.margin = item.options.margin.map((m) => m * g.sx);
        } else if (g.matrix.is2D)
          diagnostic(
            node,
            'affine-text',
            'Skewed or non-uniformly scaled editable text requires a native text transform implementation',
          );
        if (!node.querySelector('br') && s.whiteSpace === 'normal') {
          const restored = [];
          for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
            if (getComputedStyle(ancestor).transform !== 'none') {
              restored.push([ancestor, ancestor.getAttribute('style')]);
              ancestor.style.setProperty('transform', 'none', 'important');
            }
            if (roots.includes(ancestor)) break;
          }
          let rows;
          try {
            const range = document.createRange();
            range.selectNodeContents(node);
            rows = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
          } finally {
            for (const [element, style] of restored.reverse()) {
              if (style === null) element.removeAttribute('style');
              else element.setAttribute('style', style);
            }
          }
          if (
            rows.length &&
            Math.max(...rows.map((r) => r.top)) < Math.min(...rows.map((r) => r.bottom))
          )
            item.options.wrap = false;
        }
        const area = node.__okouTextPaintRect || { x: g.rect.x, y: g.rect.y, w: g.w, h: g.h };
        const fill = paintedText
            ? projectFill(gradient(textPaint.backgroundImage, area.w, area.h, node), area, {
                x: g.rect.x,
                y: g.rect.y,
                w: g.w,
                h: g.h,
              })
            : null,
          stroke = parseFloat(textPaint.webkitTextStrokeWidth) || 0;
        if (fill || stroke) {
          item._nativePaint = {
            ...item._nativePaint,
            ...(fill ? { textFill: fill } : {}),
            ...(stroke
              ? {
                  textStroke: { ...color(textPaint.webkitTextStrokeColor), width: stroke },
                  noTextFill: color(textPaint.color).alpha === 0,
                }
              : {}),
          };
          for (const part of item.textParts || []) if (part.options) part.options.transparency = 0;
        }
      }
      if (item.type === 'image') item.options.transparency = 100 * (1 - alpha);
      if (item.type === 'image' && s.filter !== 'none') {
        const unhandled = s.filter
          .replace(/grayscale\((?:1|100%)\)/g, '')
          .replace(/opacity\([\d.%]+\)/g, '')
          .trim();
        if (/grayscale\((?:1|100%)\)/.test(s.filter))
          item._nativePaint = { ...item._nativePaint, grayscale: true };
        const opacity = /opacity\(([\d.]+)(%)?\)/.exec(s.filter);
        if (opacity)
          item.options.transparency =
            100 * (1 - (alpha * Number(opacity[1])) / (opacity[2] ? 100 : 1));
        if (unhandled)
          diagnostic(
            node,
            'image-filter',
            'This image filter has no implemented equivalent native effect',
          );
      }
      if (item.type === 'table')
        item._nativePaint = {
          cells: Array.from(node.rows).map((row) =>
            Array.from(row.cells).map((cell) => {
              const style = getComputedStyle(cell);
              return style.backgroundImage !== 'none'
                ? gradient(style.backgroundImage, cell.clientWidth, cell.clientHeight, cell)
                : null;
            }),
          ),
        };
      add(item);
    }
    // Resolved pseudo and list-marker text has one owner; generic recursion never emits it again.
    for (const generated of meta.generated) {
      if (!generated.text) continue;
      const ps = getComputedStyle(node, '::' + generated.kind),
        [x, y, w, h] = generated.bounds,
        unit = config.scale / 96;
      add({
        _paintOrder: generated.order,
        type: 'text',
        textParts: [{ text: generated.text, options: font(ps, config) }],
        options: {
          x: config.offX + (x - config.rootX) * unit,
          y: config.offY + (y - config.rootY) * unit,
          w: w * unit,
          h: h * unit,
          margin: 0,
          wrap: false,
          valign: 'top',
        },
      });
    }
    // The snapshot supplies the real pseudo border box, including empty CSS triangles.
    for (const generated of meta.generated) {
      if (generated.text || generated.kind === 'marker') continue;
      const ps = getComputedStyle(node, '::' + generated.kind),
        [x, y, w, h] = generated.bounds;
      const fill = color(ps.backgroundColor);
      const extra = { _paintOrder: generated.order, _paintPhase: 0 };
      const push = (item) => {
        if (item) {
          Object.assign(item, extra);
          add(item);
        }
      };
      if (fill.alpha)
        push(
          shape(
            node,
            rounded(w, h, ps).map((p) => ({
              ...p,
              x: p.x + x,
              y: p.y + y,
              ...(p.curve
                ? {
                    curve: {
                      x1: p.curve.x1 + x,
                      y1: p.curve.y1 + y,
                      x2: p.curve.x2 + x,
                      y2: p.curve.y2 + y,
                    },
                  }
                : {}),
            })),
            { kind: 'solid', stops: [{ ...fill, position: 0 }] },
            config,
          ),
        );
      const top = parseFloat(ps.borderTopWidth),
        right = parseFloat(ps.borderRightWidth),
        bottom = parseFloat(ps.borderBottomWidth),
        left = parseFloat(ps.borderLeftWidth);
      const paths = [
        [
          [0, 0],
          [w, 0],
          [w - right, top],
          [left, top],
        ],
        [
          [w, 0],
          [w, h],
          [w - right, h - bottom],
          [w - right, top],
        ],
        [
          [w, h],
          [0, h],
          [left, h - bottom],
          [w - right, h - bottom],
        ],
        [
          [0, h],
          [0, 0],
          [left, top],
          [left, h - bottom],
        ],
      ];
      for (let i = 0; i < 4; i++) {
        const c = color(ps['border' + ['Top', 'Right', 'Bottom', 'Left'][i] + 'Color']);
        if (c.alpha)
          push(
            shape(
              node,
              paths[i].map(([a, b]) => ({ x: x + a, y: y + b })),
              { kind: 'solid', stops: [{ ...c, position: 0 }] },
              config,
            ),
          );
      }
    }
    if (original.some((item) => item.type === 'text') && s.transform !== 'none')
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const a = getComputedStyle(ancestor),
          r = ancestor.getBoundingClientRect();
        if (
          (a.overflowX !== 'visible' || a.overflowY !== 'visible') &&
          (g.rect.left < r.left ||
            g.rect.right > r.right ||
            g.rect.top < r.top ||
            g.rect.bottom > r.bottom)
        ) {
          diagnostic(
            node,
            'transformed-text-clipping',
            'Native text cannot clip partial rotated glyphs to an arbitrary ancestor path',
          );
          break;
        }
        if (roots.includes(ancestor)) break;
      }
    const keepJob = original.some((item) => item.type === 'image');
    if (keepJob && result?.job) jobs.push(result.job);
    return {
      ...result,
      items: annotate(items),
      job: jobs.length
        ? async () => {
            for (const job of jobs) await job();
          }
        : null,
      stopRecursion: result?.stopRecursion ?? false,
    };
  };
  return 1;
}
`;
