export const AVATAR_PRESET_PREFIX = "preset:";

/**
 * Part of every composer URL persisted against an agent, so rolling it makes
 * `parseAvatarComposerUrl` reject every avatar saved until now and strand them
 * on the base SVG. New or reworked layers go in beside the existing ones under
 * this version instead; static.vm0.io is append-only, so a new path can never
 * serve stale content anyway.
 */
export const AVATAR_COMPOSER_ASSET_VERSION = "v31-contained-hair-fill-20260830";
/**
 * The query string stores the selected layers. The base SVG is a transparent
 * canonical image for generic renderers that do not compose those layers.
 * Persisted composer URLs keep this directly displayable representation for
 * their lifetime; it is not a temporary rollout compatibility branch.
 */
export const AVATAR_COMPOSER_BASE_URL = `https://static.vm0.io/platform/views/zero-page/assets/avatar-svg-v2/${AVATAR_COMPOSER_ASSET_VERSION}/avatar.svg`;

export const AVATAR_COMPOSER_FACE_SHAPES = [
  "round",
  "square",
  "round-angled-ears",
  "tall",
  "wide",
  "oval",
] as const;
export const AVATAR_COMPOSER_HAIR_STYLES = [
  "high-bun",
  "geometric-long",
  "center-part",
  "curly-cap",
  "long-center-part",
  "sparse",
  "triple-bun",
  "rounded-crop",
  "halo",
  "topknot-locks",
  "low-pigtails",
  "ribbon-updo",
] as const;
export const AVATAR_COMPOSER_EXPRESSIONS = [
  "neutral-smile",
  "happy",
  "surprised",
  "worried",
  "wink",
  "angry",
  "frustrated",
  "calm",
  "bashful",
  "long-nose-smile",
  "toothy-grin",
  "side-smile",
  "full-beard",
  "whistling",
  "open-mouth",
  "angular-nose-smile",
  "gentle-smile",
  "u-nose-smile",
  "stubble-smile",
] as const;
export const AVATAR_COMPOSER_SKIN_TONES = [
  "gold",
  "light",
  "deep",
  "tan",
  "brown",
] as const;
export const AVATAR_COMPOSER_HAIR_COLORS = [
  "blue",
  "yellow",
  "green",
  "black",
  "brown",
] as const;
export const AVATAR_COMPOSER_SWEATER_COLORS = [
  "lime",
  "blue",
  "yellow",
  "teal",
  "pink",
  "orange",
] as const;

const FEMININE_AVATAR_HAIR_STYLES = new Set<AvatarComposerHairStyle>([
  "high-bun",
  "geometric-long",
  "long-center-part",
  "triple-bun",
  "topknot-locks",
  "low-pigtails",
  "ribbon-updo",
]);

export type AvatarComposerFaceShape =
  (typeof AVATAR_COMPOSER_FACE_SHAPES)[number];
export type AvatarComposerHairStyle =
  (typeof AVATAR_COMPOSER_HAIR_STYLES)[number];
export type AvatarComposerExpression =
  (typeof AVATAR_COMPOSER_EXPRESSIONS)[number];
export type AvatarComposerSkinTone =
  (typeof AVATAR_COMPOSER_SKIN_TONES)[number];
export type AvatarComposerHairColor =
  (typeof AVATAR_COMPOSER_HAIR_COLORS)[number];
export type AvatarComposerSweaterColor =
  (typeof AVATAR_COMPOSER_SWEATER_COLORS)[number];

export interface AvatarComposerConfig {
  readonly face: AvatarComposerFaceShape;
  readonly hair: AvatarComposerHairStyle;
  readonly expression: AvatarComposerExpression;
  readonly skin: AvatarComposerSkinTone;
  readonly hairColor: AvatarComposerHairColor;
  readonly sweater: AvatarComposerSweaterColor;
}

export type AvatarComposerSelection =
  | { readonly field: "face"; readonly value: AvatarComposerFaceShape }
  | { readonly field: "hair"; readonly value: AvatarComposerHairStyle }
  | { readonly field: "expression"; readonly value: AvatarComposerExpression }
  | { readonly field: "skin"; readonly value: AvatarComposerSkinTone }
  | { readonly field: "hairColor"; readonly value: AvatarComposerHairColor }
  | { readonly field: "sweater"; readonly value: AvatarComposerSweaterColor };

/** Avatar used by the default assistant across branded chat surfaces. */
export const DEFAULT_AGENT_AVATAR_URL =
  "https://static.vm0.io/public/default-agent-avatar-ceb298b79964.svg";

/** Number of legacy built-in preset avatars kept for existing agent data. */
export const AVATAR_PRESET_COUNT = 5;

function oneOf<const Item>(items: readonly Item[]): Item {
  const item = items[Math.floor(Math.random() * items.length)];
  if (item === undefined) {
    throw new Error("Cannot select from an empty avatar option list");
  }
  return item;
}

function isOneOf<const Items extends readonly string[]>(
  value: string | null,
  items: Items,
): value is Items[number] {
  return (
    value !== null &&
    items.some((item) => {
      return item === value;
    })
  );
}

export function isAvatarComposerCombinationCompatible(
  hair: AvatarComposerHairStyle,
  expression: AvatarComposerExpression,
): boolean {
  return !(
    expression === "full-beard" && FEMININE_AVATAR_HAIR_STYLES.has(hair)
  );
}

export function updateAvatarComposerConfig(
  config: AvatarComposerConfig,
  selection: AvatarComposerSelection,
): AvatarComposerConfig {
  switch (selection.field) {
    case "face":
      return { ...config, face: selection.value };
    case "hair":
      return isAvatarComposerCombinationCompatible(
        selection.value,
        config.expression,
      )
        ? { ...config, hair: selection.value }
        : config;
    case "expression": {
      const hair = isAvatarComposerCombinationCompatible(
        config.hair,
        selection.value,
      )
        ? config.hair
        : AVATAR_COMPOSER_HAIR_STYLES.find((candidate) => {
            return isAvatarComposerCombinationCompatible(
              candidate,
              selection.value,
            );
          });
      if (!hair) {
        throw new Error("Avatar expression has no compatible hairstyle");
      }
      return { ...config, hair, expression: selection.value };
    }
    case "skin":
      return { ...config, skin: selection.value };
    case "hairColor":
      return { ...config, hairColor: selection.value };
    case "sweater":
      return { ...config, sweater: selection.value };
  }
}

export function randomAvatarComposerConfig(): AvatarComposerConfig {
  const expression = oneOf(AVATAR_COMPOSER_EXPRESSIONS);
  const compatibleHairStyles = AVATAR_COMPOSER_HAIR_STYLES.filter((hair) => {
    return isAvatarComposerCombinationCompatible(hair, expression);
  });
  return {
    face: oneOf(AVATAR_COMPOSER_FACE_SHAPES),
    hair: oneOf(compatibleHairStyles),
    expression,
    skin: oneOf(AVATAR_COMPOSER_SKIN_TONES),
    hairColor: oneOf(AVATAR_COMPOSER_HAIR_COLORS),
    sweater: oneOf(AVATAR_COMPOSER_SWEATER_COLORS),
  };
}

/**
 * Avatars saved before the sweater layer existed carry no `sweater` parameter.
 * Deriving one from the rest of the configuration keeps each of those avatars
 * on the same colour across reloads, and spreads the palette over the existing
 * population instead of dressing everybody in the same sweater.
 *
 * Fallback declaration, per `docs/fallback.md` §6.4 and §7:
 * - Surface: persisted `agents.avatarUrl` values written by the avatar composer
 *   before the sweater layer shipped. This is permanent legacy data, so none
 *   of the rollout gates apply — not DB/API skew, not the runner drain, not
 *   the old-client window.
 * - Removal gate: a backfill that writes an explicit `sweater` into every
 *   pre-existing composer URL. None is planned, so this branch is expected to
 *   stay.
 * - Why it is allowed: a sweater colour carries no identity, so this is a
 *   presentational default rather than a fabricated identity.
 */
function inheritedSweaterColor(
  config: Omit<AvatarComposerConfig, "sweater">,
): AvatarComposerSweaterColor {
  const key = `${config.face}|${config.hair}|${config.expression}|${config.skin}|${config.hairColor}`;
  const hash = [...key].reduce((total, character) => {
    return (total * 31 + character.charCodeAt(0)) % 1_000_003;
  }, 0);
  return AVATAR_COMPOSER_SWEATER_COLORS[
    hash % AVATAR_COMPOSER_SWEATER_COLORS.length
  ]!;
}

export function avatarComposerUrl(config: AvatarComposerConfig): string {
  const query = new URLSearchParams({
    face: config.face,
    hair: config.hair,
    expression: config.expression,
    skin: config.skin,
    hairColor: config.hairColor,
    sweater: config.sweater,
  });
  return `${AVATAR_COMPOSER_BASE_URL}?${query}`;
}

export function parseAvatarComposerUrl(
  value: string | null | undefined,
): AvatarComposerConfig | null {
  if (!value?.startsWith(`${AVATAR_COMPOSER_BASE_URL}?`)) {
    return null;
  }
  const query = new URL(value).searchParams;
  const face = query.get("face");
  const hair = query.get("hair");
  const expression = query.get("expression");
  const skin = query.get("skin");
  const hairColor = query.get("hairColor");
  const sweater = query.get("sweater");
  if (
    !isOneOf(face, AVATAR_COMPOSER_FACE_SHAPES) ||
    !isOneOf(hair, AVATAR_COMPOSER_HAIR_STYLES) ||
    !isOneOf(expression, AVATAR_COMPOSER_EXPRESSIONS) ||
    !isOneOf(skin, AVATAR_COMPOSER_SKIN_TONES) ||
    !isOneOf(hairColor, AVATAR_COMPOSER_HAIR_COLORS) ||
    !isAvatarComposerCombinationCompatible(hair, expression)
  ) {
    return null;
  }
  const head = { face, hair, expression, skin, hairColor };
  return {
    ...head,
    sweater: isOneOf(sweater, AVATAR_COMPOSER_SWEATER_COLORS)
      ? sweater
      : inheritedSweaterColor(head),
  };
}

export function randomAvatarUrl(): string {
  return avatarComposerUrl(randomAvatarComposerConfig());
}
