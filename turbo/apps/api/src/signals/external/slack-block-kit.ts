/**
 * Block Kit shapes this API builds, owned locally instead of imported from
 * `@slack/web-api`.
 *
 * The SDK declaration surface is isolated in the gateway type-check project
 * (see `tsconfig.gateways.json`), so the block builders under `lib/` and the
 * routes and services that pass blocks around cannot name the SDK's own
 * `Block`, `KnownBlock` or `View`. These types mirror the subset the codebase
 * actually constructs; the gateway is the single place that hands them to the
 * SDK, and it is where a mismatch would surface.
 */

interface SlackPlainTextObject {
  readonly type: "plain_text";
  readonly text: string;
  readonly emoji?: boolean;
}

interface SlackMrkdwnObject {
  readonly type: "mrkdwn";
  readonly text: string;
}

type SlackTextObject = SlackPlainTextObject | SlackMrkdwnObject;

interface SlackConfirmationDialog {
  readonly title: SlackPlainTextObject;
  readonly text: SlackPlainTextObject;
  readonly confirm: SlackPlainTextObject;
  readonly deny: SlackPlainTextObject;
}

interface SlackButtonElement {
  readonly type: "button";
  readonly text: SlackPlainTextObject;
  readonly action_id: string;
  readonly url?: string;
  readonly value?: string;
  readonly style?: "primary" | "danger";
  readonly confirm?: SlackConfirmationDialog;
}

interface SlackSelectOption {
  readonly text: SlackPlainTextObject;
  readonly value: string;
}

interface SlackStaticSelectElement {
  readonly type: "static_select";
  readonly action_id: string;
  readonly placeholder?: SlackPlainTextObject;
  readonly options: readonly SlackSelectOption[];
  readonly initial_option?: SlackSelectOption;
}

interface SlackActionsBlock {
  readonly type: "actions";
  readonly block_id?: string;
  readonly elements: readonly SlackButtonElement[];
}

interface SlackContextBlock {
  readonly type: "context";
  readonly block_id?: string;
  readonly elements: readonly SlackTextObject[];
}

interface SlackDividerBlock {
  readonly type: "divider";
  readonly block_id?: string;
}

interface SlackHeaderBlock {
  readonly type: "header";
  readonly block_id?: string;
  readonly text: SlackPlainTextObject;
}

interface SlackImageBlock {
  readonly type: "image";
  readonly image_url: string;
  readonly alt_text: string;
}

interface SlackInputBlock {
  readonly type: "input";
  readonly block_id?: string;
  readonly label: SlackPlainTextObject;
  readonly element: SlackStaticSelectElement;
}

export interface SlackMarkdownBlock {
  readonly type: "markdown";
  readonly block_id?: string;
  readonly text: string;
}

interface SlackSectionBlock {
  readonly type: "section";
  readonly block_id?: string;
  readonly text: SlackTextObject;
  readonly accessory?: SlackButtonElement;
}

/** The blocks this codebase constructs itself. */
export type SlackKnownBlock =
  | SlackActionsBlock
  | SlackContextBlock
  | SlackDividerBlock
  | SlackHeaderBlock
  | SlackImageBlock
  | SlackInputBlock
  | SlackMarkdownBlock
  | SlackSectionBlock;

/**
 * A block whose payload only Slack validates. API callers hand us blocks we
 * pass through verbatim, so they are typed by their discriminator alone.
 */
interface SlackBlock {
  readonly type: string;
  readonly block_id?: string;
}

export type SlackAnyBlock = SlackKnownBlock | SlackBlock;

interface SlackHomeView {
  readonly type: "home";
  readonly blocks: SlackAnyBlock[];
  readonly private_metadata?: string;
  readonly callback_id?: string;
}

interface SlackModalView {
  readonly type: "modal";
  readonly blocks: SlackAnyBlock[];
  readonly title: SlackPlainTextObject;
  readonly submit?: SlackPlainTextObject;
  readonly close?: SlackPlainTextObject;
  readonly private_metadata?: string;
  readonly callback_id?: string;
}

export type SlackView = SlackHomeView | SlackModalView;
