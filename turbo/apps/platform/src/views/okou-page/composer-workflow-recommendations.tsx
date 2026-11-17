import type { WorkflowShelfCover } from "../../signals/okou-page/composer-workflow-recommendations.ts";
import { TemplateCard } from "./template-card.tsx";
import { WorkflowCover } from "./workflow-cover.tsx";

/** A workflow cover and caption, with an optional accessible flow description. */
export function WorkflowTile({
  title,
  cover,
  description,
  onSelect,
}: {
  readonly title: string;
  readonly cover: WorkflowShelfCover;
  readonly description?: string;
  readonly onSelect: () => void;
}) {
  return (
    <TemplateCard
      title={title}
      description={description}
      slot="workflow-recommendation-tile"
      ratio="aspect-video"
      onSelect={onSelect}
    >
      <WorkflowCover cover={cover} />
    </TemplateCard>
  );
}
