import { describe, expect, it } from "vitest";

import {
  AVATAR_COMPOSER_HAIR_COLORS,
  AVATAR_COMPOSER_SKIN_TONES,
  AVATAR_COMPOSER_SWEATER_COLORS,
  type AvatarComposerConfig,
} from "../agent-avatar";
import {
  admissibleAvatarTextures,
  agentAvatarTexture,
  avatarTextureUrl,
  defaultAgentAvatarTextures,
  deltaE2000,
  AVATAR_TEXTURES,
  type AvatarTexture,
} from "../agent-avatar-texture";

type Wearable = Pick<AvatarComposerConfig, "hairColor" | "sweater" | "skin">;

function everyWearable(): Wearable[] {
  const combinations: Wearable[] = [];
  for (const hairColor of AVATAR_COMPOSER_HAIR_COLORS) {
    for (const sweater of AVATAR_COMPOSER_SWEATER_COLORS) {
      for (const skin of AVATAR_COMPOSER_SKIN_TONES) {
        combinations.push({ hairColor, sweater, skin });
      }
    }
  }
  return combinations;
}

/**
 * Colours the avatar draws as large flat blocks, taken from the layer assets.
 * Repeated here rather than exported so that a change to one of those values
 * has to be made twice, deliberately, instead of quietly moving the thresholds
 * the rule is built on.
 */
const HAIR_HEX = {
  blue: "#3758A2",
  yellow: "#F4E33C",
  green: "#007562",
  black: "#231F20",
  brown: "#A55D2D",
} as const;
const SWEATER_HEX = {
  lime: "#96D82D",
  blue: "#3363D3",
  yellow: "#F4E33C",
  teal: "#007562",
  pink: "#FFC6E2",
  orange: "#E4572E",
} as const;
const TEXTURE_HEX: Readonly<Record<AvatarTexture, readonly string[]>> = {
  "dash-pink-orange": ["#FFC6E2", "#FF602F"],
  "dash-pink-pink": ["#FFC6E2", "#FFAED6"],
  "drop-blue-lightblue": ["#3363D3", "#B4DEF5"],
  "drop-lightblue-blue": ["#B4DEF5", "#82CFFB"],
  "loop-blue-yellow": ["#3363D3", "#F9E840"],
  "loop-yellow-orange": ["#F9E840", "#FFC815"],
  "stripe-teal-green": ["#008D76", "#96D82D"],
  "stripe-lime-green": ["#BFE123", "#96D82D"],
};

function worstBlockDistance(
  texture: AvatarTexture,
  { hairColor, sweater }: Wearable,
): number {
  return Math.min(
    ...[HAIR_HEX[hairColor], SWEATER_HEX[sweater]].flatMap((block) => {
      return TEXTURE_HEX[texture].map((colour) => {
        return deltaE2000(block, colour);
      });
    }),
  );
}

describe("agent avatar texture", () => {
  it("leaves every avatar at least two textures to choose from", () => {
    for (const wearable of everyWearable()) {
      expect(
        admissibleAvatarTextures(wearable).length,
        `${wearable.hairColor}/${wearable.sweater}/${wearable.skin}`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("never offers a texture a garment would disappear into", () => {
    // The point of the rule. The sweater and the hair are drawn as large flat
    // fills, and six of the pairs in this library are the same hex on both
    // sides, so an unguarded pick hides the garment and leaves the outline
    // floating on its own.
    for (const wearable of everyWearable()) {
      for (const texture of admissibleAvatarTextures(wearable)) {
        expect(
          worstBlockDistance(texture, wearable),
          `${texture} behind ${wearable.hairColor}/${wearable.sweater}`,
        ).toBeGreaterThanOrEqual(25);
      }
    }
  });

  it("rejects the collisions an unguarded pick would make", () => {
    // Each of these shares a literal hex with one of the texture's two colours.
    const collisions = [
      ["pink", "dash-pink-pink"],
      ["blue", "drop-blue-lightblue"],
      ["lime", "stripe-lime-green"],
    ] as const;

    for (const [sweater, texture] of collisions) {
      const admissible = admissibleAvatarTextures({
        hairColor: "black",
        sweater,
        skin: "light",
      });
      expect(admissible, `${sweater} over ${texture}`).not.toContain(texture);
    }
  });

  it("keeps one agent on one texture across calls", () => {
    const wearable: Wearable = {
      hairColor: "brown",
      sweater: "teal",
      skin: "gold",
    };
    const first = agentAvatarTexture("agent-7f3a", wearable);

    expect(first).not.toBeNull();
    expect(agentAvatarTexture("agent-7f3a", wearable)).toBe(first);
    expect(admissibleAvatarTextures(wearable)).toContain(first);
  });

  it("gives an agent with no composer avatar no texture", () => {
    // The organization default agent is one flat SVG with no hair or sweater to
    // check a texture against, so it gets none rather than an unchecked one.
    expect(agentAvatarTexture("agent-default", null)).toBeNull();
  });

  it("spreads the library rather than settling on one tile", () => {
    const used = new Set<AvatarTexture>();
    for (const wearable of everyWearable()) {
      for (let index = 0; index < 8; index += 1) {
        const texture = agentAvatarTexture(`agent-${index}`, wearable);
        if (texture) {
          used.add(texture);
        }
      }
    }

    expect(used.size).toBe(AVATAR_TEXTURES.length);
  });

  it("leaves the organization default agent exactly one texture", () => {
    // It wears five brand colours at once — blue hat, orange face, lime
    // collar, pink cheeks, dark outline — and three of those are the literal
    // base or ink of a tile. Only the tonal light-blue drop clears all of them,
    // so this is a fact about the artwork rather than a preference.
    const options = defaultAgentAvatarTextures();

    expect(options).toEqual(["drop-lightblue-blue"]);
  });

  it("holds the default agent's texture to the same distance as a garment", () => {
    for (const texture of defaultAgentAvatarTextures()) {
      for (const painted of ["#3363D3", "#FFA500", "#96D82D", "#FFC6E2"]) {
        for (const colour of TEXTURE_HEX[texture]) {
          expect(deltaE2000(painted, colour)).toBeGreaterThanOrEqual(25);
        }
      }
    }
  });

  it("points every texture at its own published file", () => {
    const urls = AVATAR_TEXTURES.map(avatarTextureUrl);

    expect(new Set(urls).size).toBe(AVATAR_TEXTURES.length);
    for (const [index, url] of urls.entries()) {
      expect(url).toBe(
        `https://static.vm0.io/platform/views/zero-page/assets/avatar-texture/v1-brand-tiles-20260921/${AVATAR_TEXTURES[index]}.svg`,
      );
    }
  });

  it("measures colour the way the eye does, not the way RGB does", () => {
    // The two yellows differ by 10 in RGB and are indistinguishable on screen;
    // the teal and the lime are further apart in RGB than they look. A rule
    // built on RGB distance would admit the first pair and block the second.
    expect(deltaE2000("#F9E840", "#F4E33C")).toBeLessThan(5);
    expect(deltaE2000("#008D76", "#96D82D")).toBeGreaterThan(25);
  });
});
