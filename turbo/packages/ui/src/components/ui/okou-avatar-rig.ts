import { OKOU_AVATAR_ARTWORK } from "./okou-avatar-artwork";

/**
 * The Okou expression rig.
 *
 * Artwork, the 21 moods and every pose curve come from Liangyou's
 * "21 种小情绪 · Okou 动态头像" (v27), by way of the avatar crop lab. Each rig is
 * an independent copy of the artwork with prefixed ids, so any number can
 * share a page, and drawing a frame is a pure function of (mood, time, line
 * weight): a paused frame is reproducible.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** The artwork's own coordinate space: a 217-unit square. */
export const OKOU_AVATAR_VIEW = 217;

/** Line weight of every outline, in artwork units. */
const LINE = 2.89154;

export const OKOU_AVATAR_MOODS = [
  { id: "idle", cycle: 8, hero: 1.2 },
  { id: "happy", cycle: 4.8, hero: 0.6 },
  { id: "nod", cycle: 3.5, hero: 0.9 },
  { id: "shake", cycle: 3.6, hero: 1.5 },
  { id: "sleepy", cycle: 6.8, hero: 3.3 },
  { id: "surprise", cycle: 4.8, hero: 1.2 },
  { id: "think", cycle: 5, hero: 1.4 },
  { id: "shy", cycle: 5.2, hero: 1.3 },
  { id: "laugh", cycle: 4.8, hero: 0.55 },
  { id: "wink", cycle: 2.83, hero: 0.8 },
  { id: "angry", cycle: 2, hero: 0.5 },
  { id: "cry", cycle: 4.6, hero: 0.75 },
  { id: "pout", cycle: 4, hero: 1 },
  { id: "confused", cycle: 5, hero: 1.25 },
  { id: "sweat", cycle: 3, hero: 1 },
  { id: "party", cycle: 4.8, hero: 1.1 },
  { id: "cool", cycle: 5, hero: 1.25 },
  { id: "please", cycle: 3, hero: 0.75 },
  { id: "kiss", cycle: 3, hero: 1.2 },
  { id: "dizzy", cycle: 3, hero: 0.9 },
  { id: "focus", cycle: 6, hero: 1 },
] as const;

export type OkouAvatarMood = (typeof OKOU_AVATAR_MOODS)[number]["id"];

/** The moment each mood reads best when it has to stand still. */
export function okouAvatarHeroTime(mood: OkouAvatarMood): number {
  const entry = OKOU_AVATAR_MOODS.find((candidate) => {
    return candidate.id === mood;
  });
  return entry ? entry.hero : 0;
}

const clamp = (n: number, a = 0, b = 1): number => {
  return Math.max(a, Math.min(b, n));
};
const mod = (x: number, n: number): number => {
  return ((x % n) + n) % n;
};
const ease = (input: number): number => {
  const x = clamp(input);
  return x * x * (3 - 2 * x);
};
const pulse = (t: number, c: number, w: number): number => {
  return Math.abs(t - c) > w ? 0 : Math.cos(((t - c) / w) * (Math.PI / 2)) ** 2;
};
const origin = (x: number, y: number, body: string): string => {
  return `translate(${x} ${y}) ${body} translate(${-x} ${-y})`;
};

// Native front-art coordinates; pose amplitudes keep the original rhythm.
const UNIT = 0.41;
const HEAD_X = 108.432;
const HEAD_Y = 180.721;
const mapArt = (
  oldX: number,
  oldY: number,
  newX: number,
  newY: number,
  sx = UNIT,
  sy = UNIT,
): string => {
  return `translate(${newX} ${newY}) scale(${sx} ${sy}) translate(${-oldX} ${-oldY})`;
};
const LEGACY_MAP = mapArt(259, 441.35, HEAD_X, HEAD_Y);
const EYE_MAP = mapArt(
  258.977,
  292.905,
  108,
  121.373,
  (128.602 - 87.3978) / (323.121 - 194.833),
);
const SIDES = ["left", "right"] as const;
const STROKE =
  'stroke="#252121" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"';
const HEART =
  '<path d="M0 8C-4 4-12-1-12-7C-12-14-4-16 0-10C4-16 12-14 12-7C12-1 4 4 0 8Z" fill="#e77f98" stroke="#252121" stroke-width="2.5"/>';
const STAR =
  '<path d="m0-12 3.5 8 8.5.5-6.5 6 2 9-7.5-4.8L-7.5 11l2-8.5-6.5-6 8.5-.5Z" fill="#96d82d" stroke="#252121" stroke-width="2.5" stroke-linejoin="round"/>';

function times<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => {
    return make(index);
  });
}

function eyeOverlays(side: "left" | "right"): string {
  const x = side === "left" ? 194.833 : 323.121;
  const frontX = side === "left" ? 87.3978 : 128.602;
  const squeeze =
    side === "left"
      ? `M${x - 13} 282L${x + 1} 293L${x - 13} 304`
      : `M${x + 13} 282L${x - 1} 293L${x + 13} 304`;
  const cry =
    side === "left"
      ? `M${frontX - 6.2} 121.7Q${frontX} 127.1 ${frontX + 5.8} 121.4`
      : `M${frontX - 5.8} 121.4Q${frontX} 127.1 ${frontX + 6.2} 121.7`;
  return `
    <g id="eye-${side}-squeeze" opacity="0"><path d="${squeeze}" fill="none" ${STROKE}/></g>
    <g id="eye-${side}-spiral" opacity="0" transform="translate(${x} 293)"><path d="M0 0c-6-6-12 3-5 8s20-1 17-12S-8-21-16-7s3 28 17 27" fill="none" stroke="#252121" stroke-width="4" stroke-linecap="round"/></g>
    <g id="eye-${side}-star" opacity="0" transform="translate(${x} 293) scale(1.35)">${STAR}</g>
    <path id="eye-${side}-cry" d="${cry}" opacity="0" fill="none" stroke="#252121" stroke-width="2.89154" stroke-linecap="round"/>
    <circle id="eye-${side}-shine" opacity="0" cx="${frontX - 1.3}" cy="119.6" r="1.6" fill="#fff"/>
  `;
}

const FACE_OVERLAYS = `
  <g id="mouth-laugh" opacity="0"><path d="M254 366Q282 378 315 354C315 405 276 423 254 366Z" fill="#252121" stroke="#252121" stroke-width="5" stroke-linejoin="round"/><path d="M260 370Q283 380 308 363L305 375Q282 390 264 380Z" fill="#f8f5f3"/><path d="M276 397Q284 384 299 392Q290 405 276 397Z" fill="#ffc6e2"/></g>
  <g id="mouth-big-laugh" opacity="0"><defs><clipPath id="big-laugh-clip"><path id="big-laugh-clip-shape"/></clipPath></defs><path id="big-laugh-shape" fill="#252121"/><g clip-path="url(#big-laugh-clip)"><path id="big-laugh-teeth" fill="#f8f5f3"/><ellipse id="big-laugh-tongue" cx="116" cy="165" rx="8.5" ry="4.7" fill="#ffc6e2"/></g><path id="big-laugh-outline" fill="none" stroke="#252121" stroke-width="2.89154" stroke-linecap="round" stroke-linejoin="round"/></g>
  <g id="mouth-party" opacity="0"><defs><clipPath id="party-mouth-clip"><path id="party-mouth-clip-shape"/></clipPath></defs><path id="party-mouth-shape" fill="#252121"/><g clip-path="url(#party-mouth-clip)"><path d="M101 142H134V151.3Q117.5 155 101 151Z" fill="#f8f5f3"/><ellipse id="party-mouth-tongue" cx="118" cy="162.5" rx="5.8" ry="3" fill="#ffc6e2"/></g><path id="party-mouth-outline" fill="none" stroke="#252121" stroke-width="2.89154" stroke-linecap="round" stroke-linejoin="round"/></g>
  <g id="mouth-kiss" opacity="0"><path d="M278 364l10 7-10 7 11 7" fill="none" ${STROKE}/></g>
  <g id="tears" opacity="0"><path id="tear-stream-left" fill="none" stroke="#84c8ef" stroke-width="3.2" stroke-linecap="round"/><path id="tear-stream-right" fill="none" stroke="#84c8ef" stroke-width="3.2" stroke-linecap="round"/><path id="teardrop-left" d="M0-4C-1.1-1.5-2.5.2-2.5 1.7a2.5 2.5 0 0 0 5 0C2.5.2 1.1-1.5 0-4Z" fill="#84c8ef"/><path id="teardrop-right" d="M0-4C-1.1-1.5-2.5.2-2.5 1.7a2.5 2.5 0 0 0 5 0C2.5.2 1.1-1.5 0-4Z" fill="#84c8ef"/></g>
  <path id="mouth-cry" d="M105 157.7C107 151.2 113.2 148.5 118.5 149C124.1 149.6 128.2 153.4 128.8 157.6" opacity="0" fill="none" stroke="#252121" stroke-width="2.89154" stroke-linecap="round" stroke-linejoin="round"/>
  <g id="sweat-drop" opacity="0"><path d="M369 258C366 270 356 281 356 289a13 13 0 0 0 26 0c0-8-10-19-13-31Z" fill="#84c8ef" stroke="#252121" stroke-width="3.5"/><path d="M364 285q-3 7 2 10" stroke="#f8f5f3" stroke-width="3" stroke-linecap="round"/></g>
  <g id="glasses" opacity="0"><path d="M156 278h74l-5 24c-3 20-55 21-60 0Zm132 0h74l-9 24c-5 19-57 20-60 0Z" fill="#252121" stroke="#252121" stroke-width="6" stroke-linejoin="round"/><path d="M229 284q29-11 59 0m-132-2-20-5m226 5 20-5" fill="none" ${STROKE}/><path d="m178 287-6 14m17-14-6 16m126-16-6 14m17-14-6 16" stroke="#f8f5f3" stroke-width="3.5" opacity=".6"/></g>
`;

function confettiPiece(index: number): string {
  const color = ["#3363d3", "#96d82d", "#e77f98", "#ffa500"][index % 4];
  const shapes = [
    `<path d="M-1.4-2.8H1.4V2.8H-1.4Z" fill="${color}"/>`,
    `<path d="M-2-3Q2-1-1 1T1 4" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/>`,
    `<circle r="1.6" fill="${color}"/>`,
  ];
  return `<g id="confetti-${index}">${shapes[index % 3]}</g>`;
}

const EXTRA_OVERLAYS = `
  <g id="sleep-marks" opacity="0">${times(3, (i) => {
    return `<g id="sleep-z-${i}"><path d="M-7-7H7L-7 7H7" stroke="#252121" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></g>`;
  }).join("")}</g>
  <g id="surprise-marks" opacity="0"><path d="M91 179 75 165m28-6-7-20m320 41 18-15m-28-6 7-20" fill="none" ${STROKE}/></g>
  <g id="thinking-marks" opacity="0">${times(3, (i) => {
    return `<circle id="think-dot-${i}" cx="${384 + i * 22}" cy="156" r="4.5" fill="#3363d3"/>`;
  }).join("")}</g>
  <g id="happy-marks" opacity="0">${times(2, (i) => {
    return `<g id="sparkle-${i}"><path d="M0-10Q1-1 10 0Q1 1 0 10Q-1 1-10 0Q-1-1 0-10Z" fill="#3363d3"/></g>`;
  }).join("")}</g>
  <g id="kiss-hearts" opacity="0">${times(3, (i) => {
    return `<g id="kiss-heart-${i}">${HEART}</g>`;
  }).join("")}</g>
  <g id="anger-marks" opacity="0"><g id="anger-vein" transform="translate(395 183)" fill="none" stroke="#cc5142" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M-10-18C-7-5 3.5-4 9-14.5"/><path d="M18.5-7.5C5.5-6.5 5.5 3.5 15 11"/><path d="M7.5 18C4.5 5-5.5 5.7-11 15"/><path d="M-18 6.5C-5.5 4.5-6-4-16.5-9.5"/></g><path id="anger-steam" d="M100 225q-22-12-7-26t-7-25m335 57q22-12 7-26t7-25" fill="none" stroke="#b7aaa0" stroke-width="5" stroke-linecap="round"/></g>
  <g id="question-mark" opacity="0" transform="translate(415 155)"><path d="M-11-7C-14-26 14-26 14-10c0 11-13 9-13 20" fill="none" stroke="#3363d3" stroke-width="6" stroke-linecap="round"/><circle cx="1" cy="23" r="3.5" fill="#3363d3"/></g>
  <g id="party-confetti" opacity="0">${times(16, confettiPiece).join("")}</g>
  <g id="dizzy-stars" opacity="0">${times(3, (i) => {
    return `<g id="dizzy-star-${i}">${STAR}</g>`;
  }).join("")}</g>
  <g id="focus-marks" opacity="0"><path d="M111 229v-18h18m278 18v-18h-18M111 361v18h18m278-18v18h-18" fill="none" stroke="#3363d3" stroke-width="4" stroke-linecap="round"/></g>
`;

function requireElement(root: ParentNode, selector: string): Element {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`Okou avatar artwork is missing ${selector}`);
  }
  return element;
}

function markLines(elements: Iterable<Element>): void {
  // Facial lines keep one on-screen thickness through squash and stretch.
  for (const path of elements) {
    path.setAttribute("vector-effect", "non-scaling-stroke");
    path.setAttribute("data-line", "");
  }
}

function wrapIn(svg: Element, id: string, transform: string): void {
  const element = requireElement(svg, `#${id}`);
  const wrapper = svg.ownerDocument.createElementNS(SVG_NS, "g");
  wrapper.setAttribute("transform", transform);
  element.before(wrapper);
  wrapper.append(element);
}

function buildTemplate(): string {
  const host = document.createElement("div");
  host.innerHTML = OKOU_AVATAR_ARTWORK;
  const svg = requireElement(host, "svg");
  svg.removeAttribute("role");
  svg.removeAttribute("aria-labelledby");
  svg.removeAttribute("id");
  svg.setAttribute("aria-hidden", "true");
  for (const label of svg.querySelectorAll("title, desc")) {
    label.remove();
  }
  const scene = requireElement(svg, "#scene");
  const extras = requireElement(svg, "#extras");
  const character = document.createElementNS(SVG_NS, "g");
  character.id = "character-motion";
  scene.insertBefore(character, scene.firstElementChild);
  // Snapshot: moving a child out of `scene` mutates the live collection.
  for (const child of Array.from(scene.children)) {
    if (child !== character && child !== extras) {
      character.append(child);
    }
  }
  requireElement(svg, "#torso-art g[clip-path]").id = "torso-clip";

  for (const side of SIDES) {
    const x = side === "left" ? 194.833 : 323.121;
    const frontX = side === "left" ? 87.3978 : 128.602;
    requireElement(svg, `#eye-${side}-art`).insertAdjacentHTML(
      "beforeend",
      eyeOverlays(side),
    );
    for (const type of ["squeeze", "spiral", "star"]) {
      wrapIn(svg, `eye-${side}-${type}`, mapArt(x, 292.905, frontX, 121.373));
    }
  }
  markLines(
    requireElement(svg, "#eyes-track").querySelectorAll("path[stroke]"),
  );
  requireElement(svg, "#face-track").insertAdjacentHTML(
    "beforeend",
    FACE_OVERLAYS,
  );
  for (const id of ["mouth-laugh", "mouth-kiss"]) {
    wrapIn(svg, id, mapArt(287, 370, 119.5, 151));
  }
  wrapIn(svg, "glasses", EYE_MAP);
  markLines(
    requireElement(svg, "#glasses").querySelectorAll('path[stroke="#252121"]'),
  );
  wrapIn(svg, "sweat-drop", LEGACY_MAP);
  extras.insertAdjacentHTML("beforeend", EXTRA_OVERLAYS);
  // Snapshot: wrapping a child mutates the live collection.
  for (const child of Array.from(extras.children)) {
    if (child.id !== "party-confetti") {
      wrapIn(svg, child.id, LEGACY_MAP);
    }
  }
  return svg.outerHTML;
}

// ---------- Poses (unchanged from the source page) ----------

const neutral = () => {
  return {
    x: 0,
    y: 0,
    r: 0,
    sx: 1,
    sy: 1,
    fx: 0,
    fy: 0,
    gx: 0,
    gy: 0,
    ex: 1,
    ey: 1,
    happy: 0,
    wink: 0,
    blush: 0,
    o: 0,
    brow: 0,
    asym: 0,
    sleep: 0,
    think: 0,
    stars: 0,
    mouthHappy: 0,
    mouthSleep: 0,
    mouthShy: 0,
    frown: 0,
    flat: 0,
    laugh: 0,
    joy: 0,
    chuckle: 0,
    kiss: 0,
    squeeze: 0,
    spiral: 0,
    starEyes: 0,
    anger: 0,
    sad: 0,
    tears: 0,
    weeping: 0,
    sob: 0,
    sweat: 0,
    hearts: 0,
    glasses: 0,
    question: 0,
    confetti: 0,
    celebrate: 0,
    hop: 0,
    dizzy: 0,
    focus: 0,
    plead: 0,
  };
};

type Pose = ReturnType<typeof neutral>;
type PoseKey = keyof Pose;

/** Sets the pose for one mood at time `t`; `a` is `t` in radians of a 1s turn. */
type Posing = (p: Pose, t: number, a: number) => void;

const POSES: Record<OkouAvatarMood, Posing> = {
  idle: (p, _t, a) => {
    p.r = Math.sin(a / 8) * 3.3;
    p.fx = Math.sin(a / 8) * 1.5;
  },
  happy: (p, _t, a) => {
    const b = Math.sin(a / 2.4);
    p.y = -3 - Math.max(0, b) * 8;
    p.r = Math.sin(a / 4.8) * 3.5;
    p.sy = 1 + 0.012 * b;
    p.sx = 1 - 0.007 * b;
    p.happy = 0.98;
    p.blush = 0.48;
    p.mouthHappy = 1;
    p.stars = 0.8;
  },
  nod: (p, t) => {
    const n = pulse(mod(t, 3.5), 0.9, 0.36) + pulse(mod(t, 3.5), 1.7, 0.36);
    p.y = 9 * n;
    p.sy = 1 - 0.087 * n;
    p.sx = 1 + 0.012 * n;
    p.fy = 5 * n;
    p.gy = 6 * n;
    p.mouthHappy = 0.18;
    p.brow = 0.12;
  },
  shake: (p, t) => {
    const v = mod(t, 3.6);
    const w =
      Math.sin((v * Math.PI * 2) / 1.2) * Math.sin((Math.PI * v) / 3.6) ** 2;
    p.x = 8 * w;
    p.r = 7.5 * w;
    p.sx = 1 - 0.035 * Math.abs(w);
    p.fx = 7 * w;
    p.gx = 3 * w;
    p.brow = 0.42;
    p.asym = -0.3;
    p.mouthShy = 0.35;
  },
  sleepy: (p, t, a) => {
    const d = pulse(mod(t, 6.8), 3.3, 1.5);
    p.r = 6.5 + Math.sin(a / 6.8) * 1.8;
    p.y = 4 + 3 * d;
    p.sy = 0.985 - 0.012 * d;
    p.ey = 0.42 - 0.3 * d;
    p.gy = 3;
    p.fy = 2;
    p.brow = 0.3;
    p.sleep = 1;
    p.mouthSleep = 1;
  },
  surprise: (p, t) => {
    const v = mod(t, 4.8);
    const e = ease((v - 0.18) / 0.25) * (1 - ease((v - 2.05) / 0.85));
    p.r = -3 * e;
    p.y = -3 * e;
    p.sy = 1 + 0.035 * e;
    p.ex = 1 + 0.3 * e;
    p.ey = 1 + 0.5 * e;
    p.fy = -2 * e;
    p.brow = e;
    p.o = e;
  },
  think: (p, _t, a) => {
    p.r = -8 + Math.sin(a / 5) * 1.2;
    p.fx = 3;
    p.fy = -1;
    p.gx = 6;
    p.gy = -5;
    p.ey = 0.92;
    p.brow = 0.8;
    p.asym = 1;
    p.think = 1;
    p.mouthSleep = 0.55;
  },
  shy: (p, _t, a) => {
    p.r = 7 + Math.sin(a / 5.2) * 1.8;
    p.y = 3;
    p.sy = 0.985;
    p.fx = -1;
    p.fy = 2;
    p.gx = -4.5 + Math.sin(a / 5.2) * 1.5;
    p.gy = 5;
    p.ey = 0.82;
    p.blush = 0.85 + Math.sin(a / 3.5) * 0.1;
    p.mouthShy = 1;
  },
  laugh: (p, t, a) => {
    const v = mod(t, 4.8);
    const c =
      pulse(v, 0.55, 0.26) +
      0.9 * pulse(v, 1.14, 0.28) +
      0.72 * pulse(v, 1.75, 0.34);
    p.y = -2.3 - 2.6 * c + Math.sin(a / 4.8) * 0.5;
    p.r = -5 + Math.sin(a / 4.8) * 1.2 + 0.7 * c;
    p.sy = 0.986 + 0.008 * c;
    p.sx = 1 + 0.008 * c;
    p.fy = -1.6 - c;
    p.gy = -0.6;
    p.happy = 1;
    p.joy = 1;
    p.chuckle = c;
    p.ex = 1.06 + 0.04 * c;
    p.ey = 0.86 - 0.04 * c;
    p.blush = 0.15 + 0.08 * c;
  },
  wink: (p, t, a) => {
    const cycle = 2.83;
    const v = mod(t, cycle);
    p.wink = ease((v - 0.2) / 0.23) * (1 - ease((v - 1.13) / 0.3));
    p.r = -6 + Math.sin(a / cycle) * 1.5 - 1.2 * p.wink;
    p.mouthHappy = 0.6;
    p.blush = 0.25 + 0.15 * p.wink;
    p.stars = 0.55 + 0.45 * p.wink;
    p.gx = -2;
  },
  angry: (p, _t, a) => {
    p.x = Math.sin(a * 5) * 0.9;
    p.r = Math.sin(a / 2) * 2;
    p.ey = 0.8;
    p.brow = 1;
    p.anger = 1;
    p.frown = 0.8;
    p.blush = 0.5;
    p.sy = 1 + Math.sin(a) * 0.013;
  },
  cry: (p, t, a) => {
    const v = mod(t, 4.6);
    const sob = pulse(v, 0.75, 0.28) + 0.85 * pulse(v, 1.45, 0.32);
    p.weeping = 1;
    p.sob = sob;
    p.tears = 1;
    p.sad = 0.85;
    p.gy = 0.6;
    p.y = 2 + 2.8 * sob;
    p.r = -1.5 + Math.sin(a / 4.6) * 0.65;
    p.sy = 1 - 0.014 * sob;
    p.fy = 0.6 * sob;
    p.blush = 0.12;
  },
  pout: (p, _t, a) => {
    p.r = 4 + Math.sin(a / 4) * 1.4;
    p.ey = 1.22;
    p.ex = 1.08;
    p.sad = 1;
    p.brow = 0.8;
    p.frown = 1;
    p.blush = 0.35;
    p.gy = 3;
    p.y = 3;
    p.fx = Math.sin(a * 3) * 0.4;
  },
  confused: (p, _t, a) => {
    p.r = Math.sin(a / 5) * 7 - 3;
    p.brow = 0.9;
    p.asym = 2;
    p.gx = -4 + Math.sin(a / 5) * 3;
    p.mouthSleep = 0.8;
    p.question = 1;
    p.ey = 1.05;
  },
  sweat: (p, _t, a) => {
    p.r = -4;
    p.ey = 0.43;
    p.flat = 0.9;
    p.sweat = 1;
    p.brow = 0.45;
    p.asym = 0.8;
    p.x = Math.sin(a / 3) * 1.5;
  },
  party: (p, t) => {
    const v = mod(t, 4.8);
    const prep = pulse(v, 0.3, 0.24);
    const jump = pulse(v, 0.87, 0.52);
    p.celebrate = 1;
    p.starEyes = 1;
    p.confetti = 1;
    p.blush = 0.26;
    p.hop = 6.5 * jump - 0.8 * prep;
    p.y = 0;
    p.r = -1.3 + 1.1 * jump;
    p.sy = 1 - 0.012 * prep;
    p.fy = -0.6 * jump;
  },
  cool: (p, _t, a) => {
    p.r = -8 + Math.sin(a / 5) * 2;
    p.y = -3;
    p.glasses = 1;
    p.mouthShy = 0.7;
    p.stars = 0.65;
  },
  please: (p, _t, a) => {
    p.r = Math.sin(a / 3) * 2;
    p.y = 3 + Math.sin(a / 1.5) * 2;
    p.ex = 1.35;
    p.ey = 1.45;
    p.brow = 0.6;
    p.sad = 0.7;
    p.blush = 0.5;
    p.mouthShy = 1;
    p.plead = 1;
  },
  kiss: (p, _t, a) => {
    p.r = -8 + Math.sin(a / 3) * 2;
    p.happy = 1;
    p.kiss = 1;
    p.blush = 0.7;
    p.hearts = 1;
    p.fx = 2 + Math.sin(a / 3) * 2;
  },
  dizzy: (p, _t, a) => {
    p.r = Math.sin(a / 3) * 8;
    p.x = Math.cos(a / 3) * 4;
    p.y = Math.sin(a / 1.5) * 3;
    p.spiral = 1;
    p.dizzy = 1;
    p.o = 1;
    p.sy = 0.99;
  },
  focus: (p, _t, a) => {
    p.r = -2;
    p.ey = 0.72;
    p.brow = 1;
    p.anger = 0.5;
    p.flat = 1;
    p.focus = 1;
    p.gx = Math.sin(a / 4) * 3;
    p.gy = 1;
    p.y = -1 + Math.sin(a / 6) * 0.5;
  },
};

function poseFor(mood: OkouAvatarMood, t: number): Pose {
  const p = neutral();
  const a = t * Math.PI * 2;
  p.y = -1.3 + Math.sin(a / 4) * 1.3;
  POSES[mood](p, t, a);
  return p;
}

const ORIGINAL_MOUTH = [
  112.337, 152.703, 118.827, 151.816, 124.63, 147.174, 126.795, 141.137,
];
const MOUTHS: readonly (readonly [PoseKey, readonly number[]])[] = [
  ["mouthHappy", [105.5, 149.5, 114.2, 161, 128, 157, 131.5, 140.7]],
  ["mouthSleep", [115.8, 151.7, 119.1, 151.3, 123.2, 151.3, 125.6, 150.9]],
  ["mouthShy", [114.2, 151, 118.3, 151.4, 122.4, 148.5, 124.9, 145.6]],
  ["frown", [111.7, 156.6, 116.2, 147.6, 123.6, 147.6, 128.1, 155]],
  ["flat", [113, 151.7, 117, 151.7, 123.2, 151.7, 127.7, 151.7]],
];
const SOURCE_BROWS = {
  left: [
    83.4219, 107.703, 84.5602, 107.248, 86.1572, 106.985, 87.7617, 106.987,
    89.3662, 106.989, 90.9608, 107.254, 92.0965, 107.71,
  ],
  right: [
    132.578, 107.703, 131.44, 107.248, 129.843, 106.985, 128.238, 106.987,
    126.634, 106.989, 125.039, 107.254, 123.903, 107.71,
  ],
} as const;

let template: string | null = null;
let counter = 0;

/** Writes attributes to one rig's nodes, skipping writes that change nothing. */
interface RigWriter {
  attr: (id: string, key: string, value: string | number) => void;
  tf: (id: string, value: string) => void;
  opacity: (id: string, value: number) => void;
}

function createWriter(nodes: Map<string, Element>): RigWriter {
  const written = new Map<string, string>();
  const attr = (id: string, key: string, value: string | number) => {
    const v = String(value);
    const k = `${id}|${key}`;
    if (written.get(k) === v) {
      return;
    }
    const node = nodes.get(id);
    if (!node) {
      throw new Error(`Okou avatar rig has no node ${id}`);
    }
    written.set(k, v);
    node.setAttribute(key, v);
  };
  return {
    attr,
    tf: (id, value) => {
      attr(id, "transform", value);
    },
    opacity: (id, value) => {
      attr(id, "opacity", Math.round(clamp(value) * 1000) / 1000);
    },
  };
}

interface Frame {
  readonly p: Pose;
  readonly before: Pose;
  readonly mood: OkouAvatarMood;
  readonly time: number;
}

function drawBody(w: RigWriter, { p }: Frame, torsoClip: string): void {
  w.tf("character-motion", `translate(0 ${-p.hop})`);
  w.attr("torso-clip", "clip-path", p.celebrate > 0 ? "none" : torsoClip);
  w.tf(
    "head-motion",
    `translate(${p.x * UNIT} ${p.y * UNIT}) ${origin(HEAD_X, HEAD_Y, `rotate(${p.r}) scale(${p.sx} ${p.sy})`)}`,
  );
  w.tf("pointer-turn", `${origin(HEAD_X, HEAD_Y, "rotate(0)")} translate(0 0)`);
  w.tf("greeting", "translate(0 0)");
  const neckBottom = 194.009;
  const neckHeight = neckBottom - 178.707;
  const neckX = p.x * UNIT;
  const neckY = p.y * UNIT;
  const overlap = Math.abs(p.r) * 0.23;
  const neckScale = clamp(1 + (overlap - neckY) / neckHeight, 0.6, 1.8);
  const shear = -neckX / neckHeight;
  w.tf(
    "neck",
    `matrix(1 0 ${shear} ${neckScale} ${-shear * neckBottom} ${neckBottom * (1 - neckScale)})`,
  );
  w.tf("face-track", `translate(${p.fx * UNIT} ${p.fy * UNIT})`);
  w.tf("eyes-track", `translate(${p.gx * UNIT} ${p.gy * UNIT})`);
}

function blinkFactor(mood: OkouAvatarMood, time: number): number {
  if (mood === "wink" || mood === "cry" || mood === "party") {
    return 1;
  }
  const t = mod(time, 8);
  return (
    1 -
    0.94 *
      Math.max(pulse(t, 1.98, 0.12), pulse(t, 5.43, 0.12), pulse(t, 6, 0.1))
  );
}

function drawEye(
  w: RigWriter,
  { p, mood, time }: Frame,
  name: "left" | "right",
): void {
  const wink = name === "right" ? p.wink : 0;
  const closedWink = ease((wink - 0.82) / 0.18);
  const smile = p.happy + (1 - p.happy) * closedWink;
  const special = clamp(p.squeeze + p.spiral + p.starEyes + p.weeping);
  w.tf(
    `eye-${name}-motion`,
    `scale(${p.ex} ${p.ey * blinkFactor(mood, time)})`,
  );
  const eyeX = name === "left" ? 87.3978 : 128.602;
  w.tf(`eye-${name}-dot`, origin(eyeX, 121.373, `scale(1 ${1 - 0.69 * wink})`));
  w.opacity(`eye-${name}-dot`, (1 - smile) * (1 - special));
  w.opacity(`eye-${name}-smile`, smile * (1 - special));
  w.opacity(`eye-${name}-squeeze`, p.squeeze);
  w.opacity(`eye-${name}-spiral`, p.spiral);
  w.opacity(`eye-${name}-star`, p.starEyes);
  w.opacity(`eye-${name}-cry`, p.weeping);
  const starX = name === "left" ? 194.833 : 323.121;
  w.tf(
    `eye-${name}-star`,
    `translate(${starX} 293) scale(${1.35 + 0.08 * clamp(p.hop / 6.5)})`,
  );
  w.opacity(`eye-${name}-shine`, p.plead);
  const span = 5.3 + 2.1 * p.joy + 0.6 * p.celebrate;
  const outer = 122.6 - 0.4 * p.joy;
  const inner = 122.6 - 1.1 * p.joy;
  const startY = name === "left" ? outer : inner;
  const endY = name === "left" ? inner : outer;
  const peak = 115.2 + 3.4 * p.joy - 0.35 * p.chuckle - 0.4 * p.celebrate;
  w.attr(
    `eye-${name}-smile`,
    "d",
    `M${eyeX - span} ${startY}Q${eyeX} ${peak} ${eyeX + span} ${endY}`,
  );
}

function browPoints(p: Pose, name: "left" | "right"): number[] {
  const source = SOURCE_BROWS[name];
  const first = source[0];
  const last = source[12];
  const asymmetry = (ratio: number) => {
    return name === "left" ? -1.64 + 1.64 * ratio : 0.82 + 1.23 * ratio;
  };
  const joyLift = (ratio: number) => {
    return (
      (name === "left" ? 0.5 : 1) -
      4.6 * ratio -
      0.8 * Math.sin(Math.PI * ratio)
    );
  };
  return source.map((value, i) => {
    if (i % 2 === 0) {
      return value;
    }
    // Odd entries are y values; the x before each one places it along the brow.
    const ratio = ((source[i - 1] ?? first) - first) / (last - first);
    return (
      value -
      2.87 * p.o +
      (-3.28 + 5.33 * ratio) * p.anger +
      (2.87 - 6.15 * ratio) * p.sad +
      asymmetry(ratio) * p.asym +
      p.joy * joyLift(ratio) -
      1.1 * p.celebrate
    );
  });
}

function drawFace(w: RigWriter, { p }: Frame): void {
  w.opacity("cheeks", p.blush * 0.75);
  w.tf("cheeks", `translate(0 ${-0.7 * p.chuckle})`);
  w.tf(
    "nose",
    origin(
      108,
      142.583,
      `translate(0 ${-0.6 * p.joy}) scale(1 ${1 - 0.045 * p.joy})`,
    ),
  );
  for (const name of SIDES) {
    const points = browPoints(p, name);
    w.attr(
      `brow-${name}`,
      "d",
      `M${points.slice(0, 2).join(" ")}C${points.slice(2, 8).join(" ")}C${points.slice(8).join(" ")}`,
    );
  }
}

function drawMouth(w: RigWriter, { p }: Frame): void {
  const mouth = ORIGINAL_MOUTH.map((n, i) => {
    return (
      n +
      MOUTHS.reduce((sum, [key, shape]) => {
        return sum + ((shape[i] ?? n) - n) * p[key];
      }, 0)
    );
  });
  w.attr("smile", "d", `M${mouth[0]} ${mouth[1]}C${mouth.slice(2).join(" ")}`);
  w.opacity(
    "smile",
    1 - clamp(p.o + p.laugh + p.joy + p.kiss + p.weeping + p.celebrate),
  );
  w.opacity("mouth-o", p.o * (1 - p.laugh));
  w.opacity("mouth-laugh", p.laugh);
  w.opacity("mouth-kiss", p.kiss);
  w.opacity("mouth-cry", p.weeping);
  w.opacity("mouth-party", p.celebrate);
  const partyOpen = clamp(p.hop / 6.5);
  const partyBottom = 162 + 3.5 * partyOpen;
  const partyMouth = `M104 148.2Q117.5 154 131 146.6C130.4 ${158.2 + 1.9 * partyOpen} 124.9 ${partyBottom} 117.8 ${partyBottom}C110.6 ${partyBottom} 106 157.5 104 148.2Z`;
  for (const id of [
    "party-mouth-shape",
    "party-mouth-clip-shape",
    "party-mouth-outline",
  ]) {
    w.attr(id, "d", partyMouth);
  }
  w.attr("party-mouth-tongue", "cy", partyBottom - 1.6);
  w.opacity("mouth-big-laugh", p.joy);
  const open = 0.35 + 0.65 * p.chuckle;
  const bottom = 159 + 8 * open;
  const laughShape = `M92.5 144Q112.5 151.8 137.5 141.9C136.5 ${155 + 2 * open} 128 ${bottom} 115.4 ${bottom}C102 ${bottom + 0.8} 95 ${156 + 2 * open} 92.5 144Z`;
  for (const id of [
    "big-laugh-shape",
    "big-laugh-clip-shape",
    "big-laugh-outline",
  ]) {
    w.attr(id, "d", laughShape);
  }
  w.attr(
    "big-laugh-teeth",
    "d",
    `M89 136H142V${151.8 + 0.8 * open}Q115 ${158 + open} 89 ${153 + 0.8 * open}Z`,
  );
  w.opacity("big-laugh-tongue", 0);
  w.tf(
    "mouth-o",
    origin(119.5, 153, `scale(${0.8 + 0.2 * p.o} ${0.75 + 0.25 * p.o})`),
  );
}

function drawHair(w: RigWriter, { p, before, time }: Frame): void {
  const lag = (before.r - p.r) * 2.7;
  w.tf(
    "back-hair",
    `rotate(${lag * 0.22 + Math.sin(time * 1.4) * 0.65} 109.156 83.1318)`,
  );
  w.tf(
    "bun-bounce",
    `translate(0 ${clamp((p.y - before.y) * 0.22, -2, 2) * UNIT}) rotate(${lag + Math.sin(time * 1.6) * 1.3})`,
  );
  w.tf(
    "bun-stretch",
    `scale(${1 + Math.sin(time * 1.6) * 0.008} ${1 - Math.sin(time * 1.6) * 0.012})`,
  );
  w.tf(
    "fringe",
    `translate(0 ${clamp((p.y - before.y) * 0.1, -1.2, 1.2) * UNIT}) rotate(${lag * 0.2} 108 65.0596)`,
  );
  w.tf(
    "breathing",
    `scale(${1 + Math.sin(time * 1.6) * 0.003} ${1.015 + Math.sin(time * 1.6) * 0.015 + 0.012 * p.chuckle + 0.008 * p.sob})`,
  );
}

function drawSleepAndThought(w: RigWriter, { p, time }: Frame): void {
  w.opacity("sleep-marks", p.sleep);
  for (let i = 0; i < 3; i++) {
    const z = mod(time / 3.6 + i / 3, 1);
    w.tf(
      `sleep-z-${i}`,
      `translate(${384 + z * 42} ${205 - z * 83}) scale(${0.55 + z * 0.5})`,
    );
    w.opacity(`sleep-z-${i}`, Math.sin(Math.PI * z) * 0.8);
  }
  w.opacity("thinking-marks", p.think);
  for (let i = 0; i < 3; i++) {
    const wave = Math.sin(time * 3 - i * 1.4);
    w.opacity(`think-dot-${i}`, 0.2 + 0.8 * (0.5 + 0.5 * wave));
    w.tf(`think-dot-${i}`, `translate(0 ${-Math.max(0, wave) * 4})`);
  }
  w.opacity("surprise-marks", p.o * (1 - p.tears) * (1 - p.dizzy) * 0.85);
  w.tf("surprise-marks", `translate(0 ${-p.o * 3})`);
  w.opacity("happy-marks", p.stars);
  for (let i = 0; i < 2; i++) {
    const k = 0.7 + Math.sin(time * 3 + i * 2) * 0.25;
    const sparkleX = i ? 425 : 92;
    const sparkleY = i ? 199 : 178;
    w.tf(
      `sparkle-${i}`,
      `translate(${sparkleX} ${sparkleY}) rotate(${time * 14 * (i ? 1 : -1)}) scale(${k})`,
    );
    w.opacity(`sparkle-${i}`, 0.55 + Math.sin(time * 3 + i * 2) * 0.3);
  }
}

function drawTearsAndSweat(w: RigWriter, { p, time }: Frame): void {
  w.opacity("tears", p.tears);
  for (const [i, side] of SIDES.entries()) {
    const f = mod(time / 1.45 + i * 0.47, 1);
    const tipY = 138.5 + Math.sin(time * 2 + i) * 0.55;
    const x = i ? 135.2 : 81.2;
    const stream = i
      ? `M134 124.1C135.9 129 135.6 133.4 ${x} ${tipY}`
      : `M82.2 124.1C80.4 129.1 80.5 133.7 ${x} ${tipY}`;
    w.attr(`tear-stream-${side}`, "d", stream);
    w.tf(
      `teardrop-${side}`,
      `translate(${x + Math.sin(f * Math.PI) * 0.25 * (i ? 1 : -1)} ${tipY + f * f * 16}) scale(${0.72 + 0.28 * ease(f / 0.24)})`,
    );
    w.opacity(
      `teardrop-${side}`,
      ease(f / 0.14) * (1 - ease((f - 0.72) / 0.28)),
    );
    w.opacity(`tear-stream-${side}`, 0.86 + 0.1 * Math.sin(time * 2 + i));
  }
  const sweatPhase = mod(time / 3, 1);
  w.opacity(
    "sweat-drop",
    p.sweat * ease(sweatPhase / 0.12) * (1 - ease((sweatPhase - 0.8) / 0.2)),
  );
  w.tf("sweat-drop", `translate(0 ${sweatPhase * 50})`);
  w.opacity("glasses", p.glasses);
}

function drawHeartsAndAnger(w: RigWriter, { p, time }: Frame): void {
  w.opacity("kiss-hearts", p.hearts);
  for (let i = 0; i < 3; i++) {
    const f = mod(time / 3 + i / 3, 1);
    const x = i === 1 ? 417 : 95 + i * 12;
    w.tf(
      `kiss-heart-${i}`,
      `translate(${x + Math.sin(f * Math.PI * 2 + i) * 10} ${278 - f * 130 - i * 12}) rotate(${Math.sin(f * 4) * 12}) scale(${0.65 + 0.5 * f})`,
    );
    w.opacity(`kiss-heart-${i}`, Math.sin(Math.PI * f));
  }
  w.opacity("anger-marks", Math.max(0, p.anger - 0.6) / 0.4);
  w.tf(
    "anger-vein",
    `translate(395 183) rotate(${-16 + Math.sin(time * 5) * 2}) scale(${0.96 + Math.sin(time * 5.8) * 0.055} ${0.98 + Math.sin(time * 5.8 + 0.9) * 0.045})`,
  );
  w.tf("anger-steam", `translate(0 ${-mod(time, 1.7) * 7})`);
  w.opacity(
    "anger-steam",
    0.25 + 0.55 * Math.sin(Math.PI * mod(time / 1.7, 1)),
  );
  w.opacity("question-mark", p.question);
  w.tf(
    "question-mark",
    `translate(415 ${154 + Math.sin(time * 2) * 5}) rotate(${Math.sin(time * 2) * 9})`,
  );
}

function drawConfetti(w: RigWriter, { p, time }: Frame): void {
  w.opacity("party-confetti", p.confetti);
  for (let i = 0; i < 16; i++) {
    const j = i % 8;
    const side = i < 8 ? -1 : 1;
    const age = mod(time, 4.8) - 0.58 - j * 0.045;
    const f = clamp(age / 2.5);
    const speed = 240 + j * 32;
    const y = 137 + (j % 3) * 5 - speed * f + speed * f * f;
    const spread = 4 + (j % 4) * 3.5;
    const inward = (j % 4) * 14 * ease((78 - y) / 28);
    const x =
      (side < 0 ? 24 : 193) +
      side * spread * Math.sin(Math.PI * f) -
      side * inward +
      Math.sin(f * 4 + j) * 1.5;
    w.tf(
      `confetti-${i}`,
      `translate(${x} ${y}) rotate(${i * 39 + f * (i % 2 ? 180 : -160)}) scale(${0.75 + (j % 3) * 0.12})`,
    );
    w.opacity(`confetti-${i}`, ease(age / 0.12) * (1 - ease((f - 0.7) / 0.3)));
  }
}

function drawDizzyAndFocus(w: RigWriter, { p, time }: Frame): void {
  w.opacity("dizzy-stars", p.dizzy);
  for (let i = 0; i < 3; i++) {
    const angle = time * 2 + (i * Math.PI * 2) / 3;
    w.tf(
      `dizzy-star-${i}`,
      `translate(${259 + Math.cos(angle) * 115} ${128 + Math.sin(angle) * 26}) rotate(${time * 70}) scale(.7)`,
    );
  }
  w.opacity("focus-marks", p.focus * (0.65 + 0.25 * Math.sin(time * 2)));
  w.tf(
    "focus-marks",
    origin(259, 295, `scale(${1 + Math.sin(time * 2) * 0.025})`),
  );
}

export interface OkouAvatarRig {
  /** The rig's own `<svg>`, in the 217-unit artwork space. */
  readonly svg: SVGSVGElement;
  /**
   * Draws one frame. `pxPerUnit` is on-screen pixels per artwork unit, which
   * sets the facial line weight.
   */
  render: (frame: {
    mood: OkouAvatarMood;
    time: number;
    pxPerUnit: number;
  }) => void;
}

export function createOkouAvatarRig(): OkouAvatarRig {
  template ??= buildTemplate();
  counter += 1;
  const prefix = `okr${counter}-`;
  const html = template
    .replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`);
  const host = document.createElement("div");
  host.innerHTML = html;
  const svg = host.querySelector("svg");
  if (!svg) {
    throw new Error("Okou avatar artwork has no svg root");
  }
  const nodes = new Map<string, Element>();
  for (const element of svg.querySelectorAll("[id]")) {
    nodes.set(element.id.slice(prefix.length), element);
  }
  const lines = [...svg.querySelectorAll("[data-line]")];
  const torsoClip =
    nodes.get("torso-clip")?.getAttribute("clip-path") ?? "none";
  const writer = createWriter(nodes);
  let lineWidth = -1;

  const setScale = (pxPerUnit: number) => {
    const width = Math.round(LINE * pxPerUnit * 1000) / 1000;
    if (width === lineWidth) {
      return;
    }
    lineWidth = width;
    for (const path of lines) {
      path.setAttribute("stroke-width", String(width));
    }
  };

  return {
    svg,
    render: ({ mood, time, pxPerUnit }) => {
      setScale(pxPerUnit);
      const frame: Frame = {
        p: poseFor(mood, time),
        before: poseFor(mood, time - 0.11),
        mood,
        time,
      };
      drawBody(writer, frame, torsoClip);
      for (const name of SIDES) {
        drawEye(writer, frame, name);
      }
      drawFace(writer, frame);
      drawMouth(writer, frame);
      drawHair(writer, frame);
      drawSleepAndThought(writer, frame);
      drawTearsAndSweat(writer, frame);
      drawHeartsAndAnger(writer, frame);
      drawConfetti(writer, frame);
      drawDizzyAndFocus(writer, frame);
    },
  };
}
