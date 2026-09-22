import type { ArtifactSignals } from "./artifact-card-signals.ts";
import type { BrowserSessionSignals } from "./browser-session-block.ts";
import type { BrowserUserActionSignals } from "./browser-user-action-block.ts";
import type { BankingSignals } from "./banking-action-block.ts";
import type { ConnectorSignals } from "./connector-action-block.ts";
import type { ConnectorAccountActionSignals } from "./connector-account-action-block.ts";
import type { ComputerUseAuthorizationSignals } from "./computer-use-authorization-block.ts";
import type { MailDraftSignals } from "./mail-draft.ts";
import type { PermissionSignals } from "./permission-card-signals.ts";
import type { PlanUpgradeSignals } from "./plan-upgrade-block.ts";

/**
 * The signals behind one resource occurrence in an event's markdown tree.
 * Action slots resolve against cards registered ahead of parsing; artifact
 * links and images register after parsing and keep their original tags.
 * The ref rides on the hast node's
 * `data`, which `rehype-raw` cannot produce, so quoted HTML cannot forge one.
 */
export type MarkdownCardRef =
  | {
      readonly kind: "artifact";
      readonly signals: ArtifactSignals;
      /** The owning thread, for lightbox targets scoped to its artifacts. */
      readonly threadId: string;
    }
  | { readonly kind: "connector-action"; readonly signals: ConnectorSignals }
  | {
      readonly kind: "connector-account-action";
      readonly signals: ConnectorAccountActionSignals;
    }
  | { readonly kind: "permission-action"; readonly signals: PermissionSignals }
  | { readonly kind: "banking-action"; readonly signals: BankingSignals }
  | { readonly kind: "unavailable-action" }
  | {
      readonly kind: "computer-use-authorization";
      readonly signals: ComputerUseAuthorizationSignals;
    }
  | { readonly kind: "plan-upgrade"; readonly signals: PlanUpgradeSignals }
  | { readonly kind: "mail-draft"; readonly signals: MailDraftSignals }
  | {
      readonly kind: "browser-session";
      readonly signals: BrowserSessionSignals;
    }
  | {
      readonly kind: "browser-user-action";
      readonly signals: BrowserUserActionSignals;
      readonly browserSessionSignals: BrowserSessionSignals;
    };

declare module "hast" {
  interface Data {
    /** Resource signals for an action slot, artifact link, or artifact image. */
    card?: MarkdownCardRef;
  }
}
