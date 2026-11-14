import type { ZodType } from "zod";
import type { NoBodyMarker } from "../contracts/trpc-contract";
import { orgContract } from "../contracts/org-routes";
import { userPreferencesContract } from "../contracts/user-preferences";
import { apiErrorSchema } from "../contracts/api-error";
import { androidUpgradeRequiredSchema } from "../contracts/android-client-compatibility";
import {
  chatThreadsContract,
  chatThreadSnapshotArchiveSchema,
  chatThreadEventsContract,
  chatThreadByIdContract,
  chatThreadMarkReadContract,
} from "../contracts/chat-threads";
import { chatEventRowSchema } from "../contracts/chat-event-rows";
import { agentsMainContract } from "../contracts/agents";
import { projectsContract } from "../contracts/projects";
import { projectSnapshotArchiveSchema } from "../validators/projects";
import { featureSwitchesContract } from "../contracts/feature-switches";
import { instructionsContract } from "../contracts/instructions";
import { chatEventsContract } from "../contracts/chat-event-send";
import { chatInputStatusContract } from "../contracts/chat-input-status";
import { onboardingStatusContract } from "../contracts/onboarding";

export interface KotlinRouteBinding {
  readonly name: string;
  readonly response: string;
  readonly request?: string;
  readonly route: {
    readonly method: string;
    readonly path: string;
    readonly body?: ZodType | NoBodyMarker;
    readonly query?: ZodType;
    readonly pathParams?: ZodType;
    readonly responses: Readonly<Record<number, ZodType>>;
  };
}

const chatReadBindings: readonly KotlinRouteBinding[] = [
  {
    name: "chatSnapshot",
    response: "ChatSnapshot",
    route: chatThreadsContract.snapshot,
  },
  {
    name: "chatEvents",
    response: "ChatEvents",
    route: chatThreadsContract.events,
  },
  {
    name: "indicators",
    response: "Indicators",
    route: chatThreadsContract.indicators,
  },
  { name: "agents", response: "Agents", route: agentsMainContract.list },
  {
    name: "projectSnapshot",
    response: "ProjectSnapshot",
    route: projectsContract.snapshot,
  },
  {
    name: "projectEvents",
    response: "ProjectEvents",
    route: projectsContract.events,
  },
  {
    name: "featureSwitches",
    response: "FeatureSwitches",
    route: featureSwitchesContract.get,
  },
];

const historyReadBindings: readonly KotlinRouteBinding[] = [
  {
    name: "historySnapshot",
    response: "HistorySnapshot",
    route: chatThreadEventsContract.snapshot,
  },
  {
    name: "historyRows",
    response: "HistoryRows",
    route: chatThreadEventsContract.rows,
  },
  {
    name: "threadDetail",
    response: "ThreadDetail",
    route: chatThreadByIdContract.get,
  },
  {
    name: "markRead",
    response: "ReadState",
    route: chatThreadMarkReadContract.markRead,
  },
];

/** Only routes used by the installed native client, not every Web contract. */
export const kotlinRouteBindings: readonly KotlinRouteBinding[] = [
  {
    name: "createThread",
    request: "CreateThreadRequest",
    response: "CreatedThread",
    route: chatThreadsContract.create,
  },
  {
    name: "sendInput",
    request: "SendRequest",
    response: "AcceptedInput",
    route: chatEventsContract.send,
  },
  {
    name: "inputStatus",
    response: "InputStatus",
    route: chatInputStatusContract.get,
  },
  {
    name: "onboardingStatus",
    response: "OnboardingStatus",
    route: onboardingStatusContract.getStatus,
  },
  {
    name: "personalInstructions",
    response: "PersonalInstructions",
    route: instructionsContract.get,
  },
  {
    name: "updatePersonalInstructions",
    response: "PersonalInstructions",
    request: "UpdateInstructionsRequest",
    route: instructionsContract.update,
  },
  { name: "organization", response: "Organization", route: orgContract.get },
  {
    name: "preferences",
    response: "UserPreferences",
    route: userPreferencesContract.get,
  },
  {
    name: "initializePreferences",
    response: "UserPreferences",
    request: "InitializePreferencesRequest",
    route: userPreferencesContract.initialize,
  },
  {
    name: "updatePreferences",
    response: "UserPreferences",
    request: "UpdatePreferencesRequest",
    route: userPreferencesContract.update,
  },
  ...chatReadBindings,
  ...historyReadBindings,
];

export interface KotlinTypeBinding {
  readonly name: string;
  readonly schema: ZodType;
  readonly direction: "input" | "output";
}

export const kotlinTypeBindings: readonly KotlinTypeBinding[] = [
  {
    name: "CreateThreadRequest",
    schema: chatThreadsContract.create.body,
    direction: "input",
  },
  {
    name: "CreatedThread",
    schema: chatThreadsContract.create.responses[201],
    direction: "output",
  },
  {
    name: "SendRequest",
    schema: chatEventsContract.send.body,
    direction: "input",
  },
  {
    name: "AcceptedInput",
    schema: chatEventsContract.send.responses[201],
    direction: "output",
  },
  {
    name: "InputStatus",
    schema: chatInputStatusContract.get.responses[200],
    direction: "output",
  },
  {
    name: "OnboardingStatus",
    schema: onboardingStatusContract.getStatus.responses[200],
    direction: "output",
  },
  {
    name: "PersonalInstructions",
    schema: instructionsContract.get.responses[200],
    direction: "output",
  },
  {
    name: "UpdateInstructionsRequest",
    schema: instructionsContract.update.body,
    direction: "input",
  },
  {
    name: "Organization",
    schema: orgContract.get.responses[200],
    direction: "output",
  },
  {
    name: "UserPreferences",
    schema: userPreferencesContract.get.responses[200],
    direction: "output",
  },
  {
    name: "InitializePreferencesRequest",
    schema: userPreferencesContract.initialize.body,
    direction: "input",
  },
  {
    name: "UpdatePreferencesRequest",
    schema: userPreferencesContract.update.body,
    direction: "input",
  },
  { name: "ApiError", schema: apiErrorSchema, direction: "output" },
  {
    name: "AndroidUpgradeRequired",
    schema: androidUpgradeRequiredSchema,
    direction: "output",
  },
  ...chatReadBindings.map(({ response, route }) => {
    return {
      name: response,
      schema: route.responses[200]!,
      direction: "output" as const,
    };
  }),
  ...historyReadBindings.map(({ response, route }) => {
    return {
      name: response,
      schema: route.responses[200]!,
      direction: "output" as const,
    };
  }),
  { name: "RawHistoryRow", schema: chatEventRowSchema, direction: "output" },
  {
    name: "ChatArchive",
    schema: chatThreadSnapshotArchiveSchema,
    direction: "input",
  },
  {
    name: "ProjectArchive",
    schema: projectSnapshotArchiveSchema,
    direction: "input",
  },
];
