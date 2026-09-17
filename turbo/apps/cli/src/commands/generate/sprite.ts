import { Command } from "commander";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  createSpriteAuthoringPacket,
  type SpritePlan,
} from "../shared/sprite-authoring";
import { dispatchGenerate } from "./lib/dispatch";
import {
  createArtifactVisibilityOption,
  type ArtifactVisibility,
} from "../shared/artifact-visibility";

const SPRITE_USAGE_COMMAND = "okou generate sprite";
const DEFAULT_MODEL = "gpt-image-2";
const AGENT_DECIDES = "agent decides";

const ASSET_TYPES = [
  "player",
  "npc",
  "creature",
  "character",
  "spell",
  "projectile",
  "impact",
  "prop",
  "summon",
  "fx",
] as const;

const ACTIONS = [
  "single",
  "idle",
  "cast",
  "attack",
  "shoot",
  "jump",
  "hurt",
  "combat",
  "walk",
  "run",
  "hover",
  "charge",
  "projectile",
  "impact",
  "explode",
  "death",
] as const;

const VIEWS = ["topdown", "side", "3-4"] as const;

const SHEETS = [
  "auto",
  "2x2",
  "2x3",
  "2x4",
  "3x3",
  "3x4",
  "4x4",
  "5x5",
  "strip-1x3",
  "strip-1x4",
  "custom",
] as const;

const BUNDLES = [
  "single",
  "unit",
  "spell",
  "combat",
  "line",
  "hero-action",
  "engine-atlas",
] as const;

const ART_STYLES = [
  "pixel-art",
  "clean-hd",
  "pixel-inspired",
  "retro-pixel",
  "map-style",
  "project-native",
] as const;

const ANCHORS = ["center", "bottom", "feet"] as const;
const MARGINS = ["tight", "normal", "safe"] as const;
const EFFECT_POLICIES = ["all", "largest"] as const;

interface SpriteOptions {
  readonly prompt?: string;
  readonly assetType?: string;
  readonly action?: string;
  readonly view?: string;
  readonly sheet?: string;
  readonly frames?: string;
  readonly bundle?: string;
  readonly artStyle?: string;
  readonly anchor?: string;
  readonly margin?: string;
  readonly effectPolicy?: string;
  readonly reference?: string;
  readonly model: string;
  readonly name?: string;
  readonly visibility?: ArtifactVisibility;
}

function validateEnum(
  flag: string,
  value: string | undefined,
  allowed: readonly string[],
): void {
  if (value !== undefined && !allowed.includes(value)) {
    throw new Error(
      `${flag} must be one of: ${allowed.join(", ")} (got "${value}")`,
    );
  }
}

function resolveFrames(value: string | undefined): string {
  if (value === undefined) {
    return AGENT_DECIDES;
  }
  if (value === "auto") {
    return value;
  }
  const frames = Number(value);
  if (!Number.isInteger(frames) || frames < 1 || frames > 64) {
    throw new Error("--frames must be 'auto' or an integer from 1 to 64");
  }
  return String(frames);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return slug.length >= 3 ? slug : "sprite";
}

export const spriteCommand = new Command()
  .name("sprite")
  .description(
    "Prepare 2D game sprite/asset authoring instructions from a prompt",
  )
  .option("--prompt <text>", "Sprite prompt/theme; can also be piped via stdin")
  .option("--asset-type <type>", `Asset type: ${ASSET_TYPES.join(", ")}`)
  .option("--action <action>", `Animation/action: ${ACTIONS.join(", ")}`)
  .option(
    "--view <view>",
    `Camera view: ${VIEWS.join(", ")} (3-4 means 3/4 view)`,
  )
  .option("--sheet <grid>", `Sheet/grid shape: ${SHEETS.join(", ")}`, "auto")
  .option("--frames <count>", "Frame count: 'auto' or an integer (1-64)")
  .option("--bundle <preset>", `Bundle preset: ${BUNDLES.join(", ")}`)
  .option(
    "--art-style <style>",
    `Sprite art style (the sprite analog of 'okou generate image --style'): ${ART_STYLES.join(", ")}`,
  )
  .option("--anchor <anchor>", `Frame anchor: ${ANCHORS.join(", ")}`)
  .option("--margin <margin>", `Safe-area margin: ${MARGINS.join(", ")}`)
  .option(
    "--effect-policy <policy>",
    `Detached-FX component policy: ${EFFECT_POLICIES.join(", ")}`,
  )
  .option(
    "--reference <url>",
    "Reference image URL for identity/style consistency",
  )
  .option(
    "--model <model>",
    "Recommended image model for raw sheets",
    DEFAULT_MODEL,
  )
  .option("--name <slug>", "Output bundle name/slug")
  .addOption(createArtifactVisibilityOption())
  .addHelpText(
    "after",
    `
Examples:
  Generate sprite:       ${SPRITE_USAGE_COMMAND} --prompt "A green slime monster idle loop"
  Pick asset + action:   ${SPRITE_USAGE_COMMAND} --asset-type creature --action idle --sheet 3x3 --prompt "A fire dragon boss"
  Hero action bundle:    ${SPRITE_USAGE_COMMAND} --asset-type player --bundle hero-action --view side --prompt "A knight with idle, run, attack, jump"
  4-direction walk:      ${SPRITE_USAGE_COMMAND} --asset-type player --action walk --view topdown --sheet 4x4 --prompt "A 16-bit RPG villager"
  Pixel art style:       ${SPRITE_USAGE_COMMAND} --art-style pixel-art --prompt "A retro fireball projectile" --sheet 2x2
  Match a reference:     ${SPRITE_USAGE_COMMAND} --reference https://example.com/hero.png --action attack --prompt "Attack animation for this hero"
  Pipe prompt:           cat brief.txt | ${SPRITE_USAGE_COMMAND}
  Show choices:          ${SPRITE_USAGE_COMMAND}

Output:
  Prints a sprite source-selection packet for the current agent: the resolved
  plan, the recommended image model, the upstream sprite skill to resolve, and
  the hard containment rules for grids, identity, and FX.
  With no --prompt and no piped input, prints the generation choices instead.

Notes:
  - The agent generates each raw sheet with built-in image generation
    (gpt-image-2 recommended) on a solid magenta background, then runs the
    sprite skill's local processor for chroma-key cleanup, frame extraction,
    alignment, QC, and transparent/GIF export.
  - Raw sprite art must originate from image generation, never from code-drawn
    primitives (Three.js/Canvas/SVG/HTML/PIL).
  - Unset flags resolve to "agent decides"; the agent infers them from the
    prompt and the skill's modes reference.`,
  )
  .action(
    withErrorHandler(async (options: SpriteOptions) => {
      validateEnum("--asset-type", options.assetType, ASSET_TYPES);
      validateEnum("--action", options.action, ACTIONS);
      validateEnum("--view", options.view, VIEWS);
      validateEnum("--sheet", options.sheet, SHEETS);
      validateEnum("--bundle", options.bundle, BUNDLES);
      validateEnum("--art-style", options.artStyle, ART_STYLES);
      validateEnum("--anchor", options.anchor, ANCHORS);
      validateEnum("--margin", options.margin, MARGINS);
      validateEnum("--effect-policy", options.effectPolicy, EFFECT_POLICIES);
      const frames = resolveFrames(options.frames);

      const dispatch = await dispatchGenerate({
        generationType: "sprite",
        prompt: options.prompt,
      });
      if (dispatch.outcome === "handled") return;
      const prompt = dispatch.prompt;

      const plan: SpritePlan = {
        assetType: options.assetType ?? AGENT_DECIDES,
        action: options.action ?? AGENT_DECIDES,
        view: options.view ?? AGENT_DECIDES,
        sheet: options.sheet ?? "auto",
        frames,
        bundle: options.bundle ?? AGENT_DECIDES,
        artStyle: options.artStyle ?? AGENT_DECIDES,
        anchor: options.anchor ?? AGENT_DECIDES,
        margin: options.margin ?? AGENT_DECIDES,
        effectPolicy: options.effectPolicy ?? AGENT_DECIDES,
        reference: options.reference ?? "none",
        model: options.model,
        name: slugify(options.name ?? prompt),
      };

      const packet = createSpriteAuthoringPacket({
        prompt,
        plan,
        visibility: options.visibility,
      });
      console.log(packet.instructions);
    }),
  );
