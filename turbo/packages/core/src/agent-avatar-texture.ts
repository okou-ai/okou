/**
 * Brand texture behind an agent avatar, on the chat home greeting only.
 *
 * Drop next to `agent-avatar.ts` in `@okouai/core`. Nothing here is persisted:
 * the avatar composer URL already carries the six values that decide a texture,
 * so `agentAvatarTexture` is a pure function of data the agent row already has. No
 * column, no migration, no backfill.
 */
import type {
  AvatarComposerConfig,
  AvatarComposerHairColor,
  AvatarComposerSkinTone,
  AvatarComposerSweaterColor,
} from "./agent-avatar";

/**
 * The eight tiles on the `Texture` page of the Brand assets Figma
 * (`hpAEF2SrEad5PzKnwRz09v`, frame `553:3`), retraced as a flat base rectangle
 * under a single ink path. Four brush motifs, each in a high-contrast and a
 * tonal colourway.
 */
export const AVATAR_TEXTURES = [
  "dash-pink-orange",
  "dash-pink-pink",
  "drop-blue-lightblue",
  "drop-lightblue-blue",
  "loop-blue-yellow",
  "loop-yellow-orange",
  "stripe-teal-green",
  "stripe-lime-green",
] as const;

export type AvatarTexture = (typeof AVATAR_TEXTURES)[number];

/** Base colour first, ink second — the two colours each tile is drawn in. */
const TEXTURE_COLORS: Readonly<
  Record<AvatarTexture, readonly [base: string, ink: string]>
> = {
  "dash-pink-orange": ["#FFC6E2", "#FF602F"],
  "dash-pink-pink": ["#FFC6E2", "#FFAED6"],
  "drop-blue-lightblue": ["#3363D3", "#B4DEF5"],
  "drop-lightblue-blue": ["#B4DEF5", "#82CFFB"],
  "loop-blue-yellow": ["#3363D3", "#F9E840"],
  "loop-yellow-orange": ["#F9E840", "#FFC815"],
  "stripe-teal-green": ["#008D76", "#96D82D"],
  "stripe-lime-green": ["#BFE123", "#96D82D"],
};

/**
 * Read off the layer assets, not off the brand palette: the sweater and hair
 * files use slightly different values from the swatches they were drawn from,
 * and it is the file that ends up on screen over the texture.
 */
const HAIR_COLOR_HEX: Readonly<Record<AvatarComposerHairColor, string>> = {
  blue: "#3758A2",
  yellow: "#F4E33C",
  green: "#007562",
  black: "#231F20",
  brown: "#A55D2D",
};
const SWEATER_COLOR_HEX: Readonly<Record<AvatarComposerSweaterColor, string>> =
  {
    lime: "#96D82D",
    blue: "#3363D3",
    yellow: "#F4E33C",
    teal: "#007562",
    pink: "#FFC6E2",
    orange: "#E4572E",
  };
const SKIN_TONE_HEX: Readonly<Record<AvatarComposerSkinTone, string>> = {
  gold: "#F8A100",
  light: "#FEC9B9",
  deep: "#733813",
  tan: "#EEA466",
  brown: "#CC7331",
};

/**
 * Sweater and hair are large flat fills over the texture. Below this distance
 * the fill merges into the background and the avatar reads as a silhouette
 * someone failed to cut out — six of the colour pairs in this library are
 * literally the same hex, so an unguarded pick lands on one 44.8% of the time.
 */
const BLOCK_MIN_DELTA_E = 25;
/**
 * Skin is a smaller area, sits above the sweater and carries its own #252121
 * outline, so it only has to stay legible rather than separate.
 */
const SKIN_MIN_DELTA_E = 14;

function srgbToLab(hex: string): readonly [number, number, number] {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(1);
  const g = channel(3);
  const b = channel(5);
  const f = (t: number): number => {
    return t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29;
  };
  const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * CIEDE2000. Plain RGB distance is not usable here: `#F9E840` and `#F4E33C`
 * are 10 apart in RGB and indistinguishable on screen, while `#008D76` and
 * `#96D82D` are further apart in RGB than they are to the eye.
 */
export function deltaE2000(first: string, second: string): number {
  const [l1, a1, b1] = srgbToLab(first);
  const [l2, a2, b2] = srgbToLab(second);
  const rad = Math.PI / 180;
  const averageL = (l1 + l2) / 2;
  const chroma1 = Math.hypot(a1, b1);
  const chroma2 = Math.hypot(a2, b2);
  const averageChroma = (chroma1 + chroma2) / 2;
  const g =
    0.5 * (1 - Math.sqrt(averageChroma ** 7 / (averageChroma ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const averageCp = (c1p + c2p) / 2;
  const h1p = (Math.atan2(b1, a1p) / rad + 360) % 360;
  const h2p = (Math.atan2(b2, a2p) / rad + 360) % 360;
  const deltaLp = l2 - l1;
  const deltaCp = c2p - c1p;
  let deltahp = 0;
  if (c1p * c2p !== 0) {
    deltahp = h2p - h1p;
    if (deltahp > 180) {
      deltahp -= 360;
    } else if (deltahp < -180) {
      deltahp += 360;
    }
  }
  const deltaHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((deltahp * rad) / 2);
  let averageHp = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) {
      averageHp = (h1p + h2p) / 2;
    } else {
      averageHp =
        h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    }
  }
  const t =
    1 -
    0.17 * Math.cos((averageHp - 30) * rad) +
    0.24 * Math.cos(2 * averageHp * rad) +
    0.32 * Math.cos((3 * averageHp + 6) * rad) -
    0.2 * Math.cos((4 * averageHp - 63) * rad);
  const sl =
    1 + (0.015 * (averageL - 50) ** 2) / Math.sqrt(20 + (averageL - 50) ** 2);
  const sc = 1 + 0.045 * averageCp;
  const sh = 1 + 0.015 * averageCp * t;
  const rt =
    -2 *
    Math.sqrt(averageCp ** 7 / (averageCp ** 7 + 25 ** 7)) *
    Math.sin(60 * Math.exp(-(((averageHp - 275) / 25) ** 2)) * rad);
  return Math.sqrt(
    (deltaLp / sl) ** 2 +
      (deltaCp / sc) ** 2 +
      (deltaHp / sh) ** 2 +
      rt * (deltaCp / sc) * (deltaHp / sh),
  );
}

/** Every texture this avatar can sit on without a colour collapsing into it. */
export function admissibleAvatarTextures(
  config: Pick<AvatarComposerConfig, "hairColor" | "sweater" | "skin">,
): readonly AvatarTexture[] {
  const blocks = [
    SWEATER_COLOR_HEX[config.sweater],
    HAIR_COLOR_HEX[config.hairColor],
  ];
  const skin = SKIN_TONE_HEX[config.skin];
  return AVATAR_TEXTURES.filter((texture) => {
    const colors = TEXTURE_COLORS[texture];
    const blockDistance = Math.min(
      ...blocks.flatMap((block) => {
        return colors.map((color) => {
          return deltaE2000(block, color);
        });
      }),
    );
    const skinDistance = Math.min(
      ...colors.map((color) => {
        return deltaE2000(skin, color);
      }),
    );
    return (
      blockDistance >= BLOCK_MIN_DELTA_E && skinDistance >= SKIN_MIN_DELTA_E
    );
  });
}

/**
 * FNV-1a over the agent id. The texture has to be the same on every render and
 * on every device, and it has to be the same after a reload, so it cannot come
 * from `Math.random()` the way the avatar itself does — the avatar is drawn
 * once and stored, this is derived on every read.
 */
function agentSeed(agentId: string): number {
  let hash = 0x81_1c_9d_c5;
  for (let index = 0; index < agentId.length; index += 1) {
    hash ^= agentId.charCodeAt(index);
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  return hash;
}

/**
 * The texture for one agent, or null when the agent has no composer avatar —
 * the organization default agent is a single flat SVG with no hair or sweater
 * to check against, so it gets no texture rather than an unchecked one.
 */
export function agentAvatarTexture(
  agentId: string,
  config: Pick<AvatarComposerConfig, "hairColor" | "sweater" | "skin"> | null,
): AvatarTexture | null {
  if (!config) {
    return null;
  }
  const options = admissibleAvatarTextures(config);
  if (options.length === 0) {
    // Every one of the 150 hair x sweater x skin combinations leaves at least
    // two textures, so this is unreachable today. It stays because adding a
    // sweater colour or a texture is what would break it, and a missing
    // texture is a better failure than an invisible sweater.
    return null;
  }
  return options[agentSeed(agentId) % options.length]!;
}

/**
 * Published under the append-only static host. The path is versioned the same
 * way the avatar layers are, so a retrace can never serve stale content.
 */
const AVATAR_TEXTURE_BASE =
  "https://static.vm0.io/platform/views/zero-page/assets/avatar-texture/v1-brand-tiles-20260921";

const AVATAR_TEXTURE_URLS: Readonly<Record<AvatarTexture, string>> = {
  "dash-pink-orange": `${AVATAR_TEXTURE_BASE}/dash-pink-orange.svg`,
  "dash-pink-pink": `${AVATAR_TEXTURE_BASE}/dash-pink-pink.svg`,
  "drop-blue-lightblue": `${AVATAR_TEXTURE_BASE}/drop-blue-lightblue.svg`,
  "drop-lightblue-blue": `${AVATAR_TEXTURE_BASE}/drop-lightblue-blue.svg`,
  "loop-blue-yellow": `${AVATAR_TEXTURE_BASE}/loop-blue-yellow.svg`,
  "loop-yellow-orange": `${AVATAR_TEXTURE_BASE}/loop-yellow-orange.svg`,
  "stripe-teal-green": `${AVATAR_TEXTURE_BASE}/stripe-teal-green.svg`,
  "stripe-lime-green": `${AVATAR_TEXTURE_BASE}/stripe-lime-green.svg`,
};

/** One file per texture, 18–32 KB each, 196 KB for the set. */
export function avatarTextureUrl(texture: AvatarTexture): string {
  return AVATAR_TEXTURE_URLS[texture];
}
