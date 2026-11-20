import {
  proactiveSuggestionsContract,
  type ProactiveSuggestionsPreference,
} from "@okouai/api-contracts/contracts/proactive-suggestions";
import type { ProactivePreference } from "@okouai/api-contracts/contracts/proactive";
import { mockApi } from "../msw-contract.ts";
import { proactiveLearningContract } from "@okouai/api-contracts/contracts/proactive-nightly";
import {
  feedContract,
  type FeedSources,
} from "@okouai/api-contracts/contracts/feed";
import { nowDate } from "../../lib/time.ts";

const defaultSources: FeedSources = {
  suggestions: true,
  whatsNew: true,
  offers: true,
  systemUpdates: true,
};
let sources = { ...defaultSources };
let preference: ProactiveSuggestionsPreference = {
  enabled: false,
  status: "paused",
  unavailableReason: null,
};
let learning: ProactivePreference = {
  enabled: false,
  status: "paused",
  unavailableReason: null,
};
export function resetMockProactiveSuggestions(): void {
  sources = { ...defaultSources };
  preference = { enabled: false, status: "paused", unavailableReason: null };
  learning = { enabled: false, status: "paused", unavailableReason: null };
}
export const apiProactiveSuggestionsHandlers = [
  // The For you row follows the feed and unread summary whenever Suggestions are on.
  mockApi(feedContract.list, ({ respond }) => respond(200, { items: [] })),
  mockApi(feedContract.summary, ({ respond }) =>
    respond(200, { hasUnread: false }),
  ),
  mockApi(feedContract.sources, ({ respond }) => respond(200, sources)),
  mockApi(feedContract.updateSources, ({ body, respond }) => {
    sources = { ...sources, ...body };
    return respond(200, sources);
  }),
  mockApi(proactiveSuggestionsContract.updateWithFeed, ({ body, respond }) => {
    sources = { ...sources, suggestions: body.enabled };
    preference = {
      ...preference,
      enabled: body.enabled,
      status: body.enabled ? "enabled" : "paused",
    };
    return respond(200, preference);
  }),
  mockApi(feedContract.markRead, ({ respond }) =>
    respond(200, { readAt: nowDate().toISOString() }),
  ),
  mockApi(proactiveLearningContract.get, ({ respond }) =>
    respond(200, learning),
  ),
  mockApi(proactiveLearningContract.update, ({ body, respond }) => {
    learning = {
      ...learning,
      enabled: body.enabled,
      status: body.enabled ? "enabled" : "paused",
    };
    return respond(200, learning);
  }),
  mockApi(proactiveSuggestionsContract.get, ({ respond }) =>
    respond(200, preference),
  ),
  mockApi(proactiveSuggestionsContract.update, ({ body, respond }) => {
    preference = {
      ...preference,
      enabled: body.enabled,
      status: body.enabled ? "enabled" : "paused",
    };
    return respond(200, preference);
  }),
];
