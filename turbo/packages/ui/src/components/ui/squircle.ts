/**
 * A rounded rectangle with smoothed ("continuous") corners, as Figma draws it
 * with corner smoothing. Each corner eases from the straight edge into a
 * circular arc over `(1 + smoothing) * radius`, so the curvature has no step
 * where a plain border-radius has one.
 *
 * Geometry after phamfoo/figma-squircle (MIT).
 */

const toRadians = (degrees: number): number => {
  return (degrees * Math.PI) / 180;
};

const round = (value: number): number => {
  return Math.round(value * 10_000) / 10_000;
};

interface CornerParams {
  a: number;
  b: number;
  c: number;
  d: number;
  p: number;
  arc: number;
  radius: number;
}

function cornerParams(
  radius: number,
  requestedSmoothing: number,
  budget: number,
): CornerParams {
  const smoothing = Math.min(requestedSmoothing, budget / radius - 1);
  const p = Math.min((1 + requestedSmoothing) * radius, budget);
  const arcMeasure = 90 * (1 - smoothing);
  const arc = Math.sin(toRadians(arcMeasure / 2)) * radius * Math.SQRT2;
  const alpha = (90 - arcMeasure) / 2;
  const tangent = radius * Math.tan(toRadians(alpha / 2));
  const beta = 45 * smoothing;
  const c = tangent * Math.cos(toRadians(beta));
  const d = c * Math.tan(toRadians(beta));
  const b = (p - arc - c - d) / 3;
  return { a: 2 * b, b, c, d, p, arc, radius };
}

/** SVG path data for a `width` x `height` squircle starting at the origin. */
export function squirclePath(
  width: number,
  height: number,
  radius: number,
  smoothing: number,
): string {
  const { a, b, c, d, p, arc } = cornerParams(
    radius,
    smoothing,
    Math.min(width, height) / 2,
  );
  const r = round(radius);
  const n = (value: number) => {
    return round(value);
  };
  const ab = a + b;
  const abc = a + b + c;
  const bc = b + c;
  return [
    `M${n(width - p)} 0`,
    `c${n(a)} 0 ${n(ab)} 0 ${n(abc)} ${n(d)}`,
    `a${r} ${r} 0 0 1 ${n(arc)} ${n(arc)}`,
    `c${n(d)} ${n(c)} ${n(d)} ${n(bc)} ${n(d)} ${n(abc)}`,
    `L${n(width)} ${n(height - p)}`,
    `c0 ${n(a)} 0 ${n(ab)} ${n(-d)} ${n(abc)}`,
    `a${r} ${r} 0 0 1 ${n(-arc)} ${n(arc)}`,
    `c${n(-c)} ${n(d)} ${n(-bc)} ${n(d)} ${n(-abc)} ${n(d)}`,
    `L${n(p)} ${n(height)}`,
    `c${n(-a)} 0 ${n(-ab)} 0 ${n(-abc)} ${n(-d)}`,
    `a${r} ${r} 0 0 1 ${n(-arc)} ${n(-arc)}`,
    `c${n(-d)} ${n(-c)} ${n(-d)} ${n(-bc)} ${n(-d)} ${n(-abc)}`,
    `L0 ${n(p)}`,
    `c0 ${n(-a)} 0 ${n(-ab)} ${n(d)} ${n(-abc)}`,
    `a${r} ${r} 0 0 1 ${n(arc)} ${n(-arc)}`,
    `c${n(c)} ${n(-d)} ${n(bc)} ${n(-d)} ${n(abc)} ${n(-d)}`,
    "Z",
  ].join("");
}
