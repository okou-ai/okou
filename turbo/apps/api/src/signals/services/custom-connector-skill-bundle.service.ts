import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { prepareContentBundle } from "@okouai/core/content-bundle";
import { orgCustomConnectorSkillPublications } from "@okouai/db/schema/org-custom-connector-skill-publication";
import { customConnectorSkillBundleSelection } from "./custom-connector-skill-bundle-columns";
import { db$ } from "../external/db";
import { getCustomConnectorSkillName } from "@okouai/core/storage-names";
import { synthesizeSkillMd } from "@okouai/core/skill-document";
import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import { publishContentBundle$ } from "./content-bundle.service";

const SKILL_FILENAME = "SKILL.md";

export interface PreparedCustomConnectorSkill {
  readonly contentBundle: ContentBundle;
  readonly sourceVersionId: string;
}

interface CustomConnectorSkillContentInput {
  readonly orgId: string;
  readonly connectorId: string;
  readonly connectorSlug: string;
  readonly displayName: string;
  readonly skillMarkdown: string;
  readonly skillName?: string;
  readonly skillDescription?: string;
}

function buildCustomConnectorSkillFiles(
  args: CustomConnectorSkillContentInput,
): readonly { readonly path: string; readonly content: string }[] {
  return [
    {
      path: SKILL_FILENAME,
      content: synthesizeSkillMd({
        name:
          args.skillName ??
          getCustomConnectorSkillName(args.connectorSlug, args.connectorId),
        description: args.skillDescription ?? args.displayName,
        instruction: args.skillMarkdown,
      }),
    },
  ];
}

export const prepareCustomConnectorSkillBundle$ = command(
  async (
    { get, set },
    args: CustomConnectorSkillContentInput,
    signal: AbortSignal,
  ): Promise<PreparedCustomConnectorSkill> => {
    const files = buildCustomConnectorSkillFiles(args).map((file) => {
      return {
        path: file.path,
        content: Buffer.from(file.content, "utf8"),
        mode: 0o644 as const,
      };
    });
    const prepared = await prepareContentBundle(files);
    signal.throwIfAborted();
    const [registered] = await get(db$)
      .select(customConnectorSkillBundleSelection())
      .from(orgCustomConnectorSkillPublications)
      .where(
        and(
          eq(orgCustomConnectorSkillPublications.id, args.connectorId),
          eq(orgCustomConnectorSkillPublications.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    // Reuse a publication attested by this owner, including its historical source
    // ID. An unchanged edit must not require a successful remote object read.
    if (
      registered?.skillContentBundle?.sha256 === prepared.descriptor.sha256 &&
      registered.skillContentBundle.archiveBytes ===
        prepared.descriptor.archiveBytes &&
      registered.skillContentBundleSourceVersionId !== null
    ) {
      return {
        contentBundle: registered.skillContentBundle,
        sourceVersionId: registered.skillContentBundleSourceVersionId,
      };
    }
    const contentBundle = await set(publishContentBundle$, files, signal);
    // New publications derive that identity from the canonical bundle bytes;
    // it no longer names a generic Storage version. Historical IDs stay intact.
    return { contentBundle, sourceVersionId: contentBundle.sha256 };
  },
);
