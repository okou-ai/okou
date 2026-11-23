/**
 * The mark a workspace shows until an admin uploads a logo: a tonal brand texture.
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
}

/** Four brush motifs, each on a light and a dark ground. */
export const WORKSPACE_LOGO_COLORWAYS: readonly WorkspaceLogoColorway[] = [
  {
    textureUrl: avatarTextureUrl("dash-pink-pink"),
    ground: "#FFC6E2",
    ink: "#FFAED6",
  },
  {
    textureUrl: `${TONAL_DARK_GROUND_BASE}/dash-coral-red.svg`,
    ground: "#FF602F",
    ink: "#F2491A",
  },
  {
    textureUrl: avatarTextureUrl("drop-lightblue-blue"),
    ground: "#B4DEF5",
    ink: "#82CFFB",
  },
  {
    textureUrl: `${TONAL_DARK_GROUND_BASE}/drop-blue-navy.svg`,
    ground: "#3363D3",
    ink: "#2A55BE",
  },
  {
    textureUrl: avatarTextureUrl("loop-yellow-orange"),
    ground: "#F9E840",
    ink: "#FFC815",
  },
  {
    textureUrl: `${TONAL_DARK_GROUND_BASE}/loop-orange-amber.svg`,
    ground: "#FFA500",
    ink: "#FF9100",
  },
  {
    textureUrl: avatarTextureUrl("stripe-lime-green"),
    ground: "#BFE123",
    ink: "#96D82D",
  },
  {
    textureUrl: `${TONAL_DARK_GROUND_BASE}/stripe-teal-pine.svg`,
    ground: "#008D76",
    ink: "#007562",
  },
];

export function workspaceLogoColorway(orgId: string): WorkspaceLogoColorway {
  const seed = Number.parseInt(fnv1a(orgId), 16);
  return WORKSPACE_LOGO_COLORWAYS[seed % WORKSPACE_LOGO_COLORWAYS.length]!;
}
