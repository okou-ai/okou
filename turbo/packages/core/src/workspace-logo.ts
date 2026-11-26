/**
 * The mark a workspace shows until an admin uploads a logo: a tonal brand
 * texture carrying the workspace's initial.
 *
 * Clerk gives every organization an `imageUrl`, including a generated
 * placeholder when nothing was uploaded, so the App draws this instead whenever
 * `hasImage` is false. Like the agent texture, the colourway is a pure
 * function of the organization id: nothing is persisted, and the same
 * workspace looks the same in the switcher, in invitations and in Settings.
 */
import { avatarTextureUrl } from "./agent-avatar-texture";
import { fnv1a } from "./identity-hash";

/**
 * Published under the append-only static host beside the v1 library. Each is
 * the matching v1 tonal tile with its two fills moved to a dark ground.
 */
const TONAL_DARK_GROUND_BASE =
  "https://static.vm0.io/platform/views/zero-page/assets/avatar-texture/v2-tonal-dark-grounds-20261028";

interface WorkspaceLogoColorway {
  /** A ground and a second tone of the same hue, drawn as one tile. */
  readonly textureUrl: string;
  /** The tile's base fill, painted while the texture is still loading. */
  readonly ground: string;
  readonly ink: string;
  /**
   * The initial's colour: the ground's own hue, lighter on grounds darker than
   * OKLCH L 0.62 and darker otherwise, with its lightness solved to 4.5:1
   * against the lower-contrast of ground and ink (teal tops out near 4:1).
   * A same-hue tone reads as part of the tile; the brand's contrasting pair
   * colours sit on it like a sticker and fall under 3:1 on five grounds.
   */
  readonly letter: string;
}

/** Four brush motifs, each on a light and a dark ground. */
export const WORKSPACE_LOGO_COLORWAYS: readonly WorkspaceLogoColorway[] = [
  {
    textureUrl: avatarTextureUrl("dash-pink-pink"),
    ground: "#FFC6E2",
    ink: "#FFAED6",
    letter: "#6E485B",
  },
  {
    textureUrl: `${TONAL_DARK_GROUND_BASE}/dash-coral-red.svg`,
    ground: "#FF602F",
    ink: "#F2491A",
    letter: "#480000",
  },
  {
    textureUrl: avatarTextureUrl("drop-lightblue-blue"),
    ground: "#B4DEF5",
    ink: "#82CFFB",
    letter: "#395766",
  },
  {
    textureUrl: `${TONAL_DARK_GROUND_BASE}/drop-blue-navy.svg`,
    ground: "#3363D3",
    ink: "#2A55BE",
    letter: "#D9ECFF",
  },
  {
    textureUrl: avatarTextureUrl("loop-yellow-orange"),
    ground: "#F9E840",
    ink: "#FFC815",
    letter: "#675900",
  },
  {
    textureUrl: `${TONAL_DARK_GROUND_BASE}/loop-orange-amber.svg`,
    ground: "#FFA500",
    ink: "#FF9100",
    letter: "#6E2F00",
  },
  {
    textureUrl: avatarTextureUrl("stripe-lime-green"),
    ground: "#BFE123",
    ink: "#96D82D",
    letter: "#465900",
  },
  {
    textureUrl: `${TONAL_DARK_GROUND_BASE}/stripe-teal-pine.svg`,
    ground: "#008D76",
    ink: "#007562",
    letter: "#EAFFFE",
  },
];

export function workspaceLogoColorway(orgId: string): WorkspaceLogoColorway {
  const seed = Number.parseInt(fnv1a(orgId), 16);
  return WORKSPACE_LOGO_COLORWAYS[seed % WORKSPACE_LOGO_COLORWAYS.length]!;
}

/**
 * Workspaces created from the App are named from their generated slug until
 * someone renames them; every one of them would otherwise show "W".
 */
const GENERATED_WORKSPACE_NAME = /^workspace-[0-9a-f]{8}$/i;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/**
 * The first letter or number of a workspace name, as one grapheme so accented
 * Latin, Hangul syllables and combining marks stay whole. Leading emoji and
 * symbols are skipped. A letter whose capital spells more than one grapheme
 * (ß → SS) keeps its own form. Returns null for generated names and names
 * without a letter; those show the texture alone.
 */
export function workspaceInitial(name: string): string | null {
  const trimmed = name.trim();
  if (GENERATED_WORKSPACE_NAME.test(trimmed)) {
    return null;
  }
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of segmenter.segment(trimmed)) {
    if (!LETTER_OR_NUMBER.test(segment)) {
      continue;
    }
    // Locale-independent, so a Turkish browser still shows "I".
    const upper = segment.toUpperCase();
    return [...segmenter.segment(upper)].length === 1 ? upper : segment;
  }
  return null;
}

const WIDE_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * CJK glyphs fill their em box where Latin capitals fill about 70% of it, so
 * they are set at 0.88 of the Latin size to carry the same weight in the tile.
 */
export function isWideWorkspaceInitial(initial: string): boolean {
  return WIDE_SCRIPT.test(initial);
}
