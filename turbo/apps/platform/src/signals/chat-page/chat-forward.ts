import type { ComposerSignals } from "../okou-page/composer-signals.ts";
import type { FeedbackInput } from "../okou-page/chat-feedback.ts";
import type { ChatRunSource } from "./chat-event-signals.ts";

export interface ChatForwardTarget {
  readonly title: string;
}

export interface ChatForwardSelection extends FeedbackInput {
  readonly threadId: string;
  readonly runId: string;
}

export interface ChatForwardComposerState {
  readonly target: ChatForwardTarget;
  readonly composer: ComposerSignals;
}

export interface ChatForwardContext extends ChatRunSource, FeedbackInput {}
