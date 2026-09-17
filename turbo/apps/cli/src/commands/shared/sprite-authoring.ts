/**
 * Sprite generation source-selection packet.
 *
 * `okou generate sprite` does not run a server-side pipeline. Like the website
 * and styled-image commands, it "bounces" a structured authoring packet back to
 * the calling agent: the resolved sprite plan, the recommended image model, the
 * upstream sprite skill to resolve, and the hard containment rules the agent
 * must honor when it drives built-in image generation plus local postprocessing.
 */

import type { ArtifactVisibility } from "./artifact-visibility";

export interface SpritePlan {
  readonly assetType: string;
  readonly action: string;
  readonly view: string;
  readonly sheet: string;
  readonly frames: string;
  readonly bundle: string;
  readonly artStyle: string;
  readonly anchor: string;
  readonly margin: string;
  readonly effectPolicy: string;
  readonly reference: string;
  readonly model: string;
  readonly name: string;
}

interface SpriteAuthoringOptions {
  readonly prompt: string;
  readonly plan: SpritePlan;
  readonly visibility?: ArtifactVisibility;
}

interface SpriteAuthoringPacket {
  readonly type: "generation-source-selection";
  readonly kind: "sprite";
  readonly prompt: string;
  readonly plan: SpritePlan;
  readonly model: string;
  readonly outputDir: string;
  readonly skill: {
    readonly repo: string;
    readonly ref: string;
    readonly skillPath: string;
    readonly references: readonly string[];
    readonly script: string;
  };
  readonly instructions: string;
}

const SPRITE_SKILL = {
  repo: "0x0funky/agent-sprite-forge",
  ref: "main",
  skillPath: "skills/generate2dsprite/SKILL.md",
  references: [
    "skills/generate2dsprite/references/prompt-rules.md",
    "skills/generate2dsprite/references/modes.md",
  ],
  script: "skills/generate2dsprite/scripts/generate2dsprite.py",
} as const;

const CORE_INVARIANTS = [
  "Every raw sprite image must come from built-in image generation. Never draw raw sprite art with Three.js, Canvas, SVG, HTML/CSS, PIL shapes, procedural geometry, placeholder primitives, or code-rendered screenshots. Code may only assemble layout guides, postprocess generated images, or display finished assets at runtime.",
  "Background is 100% solid flat magenta `#FF00FF` with no gradient, so the local processor can chroma-key it to transparency. Keep this rule unless the user explicitly wants a different processing workflow.",
  "No text, labels, UI, speech bubbles, borders, or frames between cells. Generate the exact requested grid count only.",
  "Keep the same asset identity, the same bounding box, and the same pixel scale across every frame.",
  "Containment: the entire subject fits fully inside each cell with magenta margin on all four sides. No limb, weapon, tail, wing tip, orb, spark, or trail may cross a cell edge.",
  "Do not use raw single-row sheets (1x4, 1x6, 1x8, 1xN) for any body subject — players, heroes, creatures, NPCs, enemies, summons, or animated props. Use centered multi-row grids: 4 frames -> 2x2, 6 -> 2x3, 8 -> 2x4, 9 -> 3x3, 12 -> 3x4 or 4x3, 16 -> 4x4.",
  "For controllable heroes and main characters, attack/shoot/cast body sheets are body-only by default and must preserve idle/run body scale and the feet/bottom anchor. Generate slash arcs, weapon trails, muzzle flashes, projectiles, dust, and impacts as separate fx/projectile/impact sheets unless the runtime explicitly supports wider per-action cells plus per-action origins.",
  "For map prop packs, classify props first. Square 2x2/3x3/4x4 packs are only for compact props. Floors, platforms, bridges, walls, ladders, gates, doors, long hazards, wide/tall props, collision-bearing objects, and tileset/strip pieces use one-by-one generation, 1x3/1x4 strips, custom wide cells, or a tileset-like atlas instead.",
  "Mixed-action atlases (4x4, 5x5, custom) are a deterministic delivery step assembled from separate per-action sheets after each passes QC — never one raw mixed-action image. Raw multi-cell grids are valid only for one coherent action family, canonical directional locomotion, prop packs, or tileset-like atlases.",
] as const;

const WORKFLOW = [
  "1. Resolve the upstream skill below, then infer or confirm the asset plan. Pick the smallest useful output and do not pad unrelated actions into one raw sheet.",
  "2. Write the art prompt by hand using the skill's prompt-rules. Lock the art style, the exact sheet shape, the solid magenta background, the identity, and the containment rules. Do not delegate prompt writing to a script.",
  "3. Generate each raw sheet with built-in image generation using the recommended model below. If a reference is involved, make it visible to the model first (view a local file before generating); never pass a bare filesystem path as the visual reference.",
  "4. Postprocess each raw sheet locally with the skill's processor script: magenta cleanup, frame extraction, alignment, shared-scale normalization, component filtering, QC metadata, transparent sheet export, and GIF export.",
  "5. QC each sheet: no frame touches a cell edge, scale is consistent, detached FX did not become noise, the sheet reads as one coherent animation, and hero/player body height matches the accepted idle/run scale within ~10-15%. Reprocess or regenerate if it fails.",
  "6. Return the bundle for the resolved plan (single sheet, unit/spell/combat bundle, line bundle, or hero action bundle with separate FX assets and an optional assembled engine atlas after per-action QC).",
] as const;

const EXPECTED_OUTPUTS = [
  "`raw-sheet.png` (and one raw sheet per action for bundles)",
  "`raw-sheet-clean.png` (magenta cleaned)",
  "`sheet-transparent.png`",
  "per-frame PNGs",
  "`animation.gif` (per direction/action where applicable)",
  "`prompt-used.txt`",
  "`pipeline-meta.json`",
] as const;

export function createSpriteAuthoringPacket(
  options: SpriteAuthoringOptions,
): SpriteAuthoringPacket {
  const { prompt, plan } = options;
  const outputDir = `./generated/sprites/${plan.name}`;
  const visibilityFlag =
    options.visibility === undefined
      ? ""
      : ` --visibility ${options.visibility}`;

  const planEntries: ReadonlyArray<readonly [string, string]> = [
    ["Asset type", plan.assetType],
    ["Action", plan.action],
    ["View", plan.view],
    ["Sheet / grid", plan.sheet],
    ["Frames", plan.frames],
    ["Bundle", plan.bundle],
    ["Art style", plan.artStyle],
    ["Anchor", plan.anchor],
    ["Margin", plan.margin],
    ["Effect policy", plan.effectPolicy],
    ["Reference", plan.reference],
  ];

  const instructions = [
    "# Okou generate sprite",
    "",
    "This is a federated generation source-selection packet for the current agent.",
    "Okou is not generating these sprites on the server. You resolve the sprite skill below, write the art prompt yourself, generate each raw sheet with built-in image generation, then run the skill's local processor for chroma-key cleanup, frame extraction, alignment, QC, and transparent/GIF export.",
    "",
    "## User Prompt",
    prompt,
    "",
    "## Sprite Plan",
    "These parameters were resolved from the command. `agent decides` means the flag was not set — infer the best value from the prompt and the skill's modes reference; do not force the user to spell it out.",
    "",
    ...planEntries.map(([label, value]) => {
      return `- ${label}: ${value}`;
    }),
    `- Output name: ${plan.name}`,
    "",
    "## Recommended Model",
    `- Use \`${plan.model}\` for every raw sheet via built-in image generation (\`okou generate image --provider built-in --model ${plan.model} --raw-prompt "..."\`, or the in-context image tool).`,
    "- gpt-image-2 is recommended for sprite sheets: it accepts flexible WIDTHxHEIGHT sizes and high quality for crisp, evenly-spaced grids. It does not emit transparent backgrounds, which is expected here — the solid magenta background is chroma-keyed by the local processor.",
    "- Pick a sheet-friendly square or grid-aligned size (for example 1024x1024 for 2x2/3x3/4x4) so each cell stays evenly spaced.",
    "",
    "## Workflow Skill",
    "Resolve this skill before authoring; it is the authority for sprite prompt patterns, sheet/bundle selection, and the postprocessing primitive.",
    "",
    `- Repo: \`${SPRITE_SKILL.repo}@${SPRITE_SKILL.ref}\``,
    `- Skill: \`${SPRITE_SKILL.skillPath}\``,
    `- References: ${SPRITE_SKILL.references
      .map((ref) => {
        return `\`${ref}\``;
      })
      .join(", ")}`,
    `- Processor script: \`${SPRITE_SKILL.script}\``,
    "- For map props that must match a tile map, prefer the sibling `generate2dmap` skill in the same repo.",
    "- If a source file cannot be fetched, state that limitation and fall back to the core invariants below.",
    "",
    "## Core Invariants",
    ...CORE_INVARIANTS.map((rule) => {
      return `- ${rule}`;
    }),
    "",
    "## Workflow",
    ...WORKFLOW,
    "",
    "## Output Contract",
    `- Write the bundle under \`${outputDir}/\`.`,
    "- Keep the original generated images and produce, per sheet:",
    ...EXPECTED_OUTPUTS.map((item) => {
      return `  - ${item}`;
    }),
    "- For bundles, create one subfolder per asset and keep the per-action FX/projectile/impact sheets separate.",
    options.visibility === undefined
      ? "- With privateArtifacts enabled, new artifacts default to only-me. Otherwise, generation and upload keep their existing behavior."
      : `- Use ${options.visibility} visibility for delivered files. Explicit visibility requires privateArtifacts to be enabled.`,
    "- Keep raw intermediate sheets at their default visibility. Apply the selected visibility only when uploading the final files requested by the user.",
    `- Deliver each requested file with \`okou web upload-file -f <file>${visibilityFlag}\` and return the exact URL it prints.`,
    "",
    "## Verification",
    "- Confirm each transparent sheet and its frames are nonblank and free of magenta fringing.",
    "- Confirm no frame touches a cell edge and that scale and identity stay consistent across frames.",
    "- For hero/player body actions, confirm body height matches the accepted idle/run scale within ~10-15%.",
    "- Report the output directory, the final assets, and the resolved plan.",
  ].join("\n");

  return {
    type: "generation-source-selection",
    kind: "sprite",
    prompt,
    plan,
    model: plan.model,
    outputDir,
    skill: SPRITE_SKILL,
    instructions,
  };
}
