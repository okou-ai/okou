import type { Command } from "ccstate";
import { expectTypeOf, test } from "vitest";
import type {
  setAblyInvalidationLoop$,
  setAblyLoop$,
  setAblyPayloadLoop$,
  waitAblyInvalidationLoopUntil$,
  waitAblyLoopUntil$,
  waitAblyPayloadLoopUntil$,
} from "../../signals/realtime.ts";
import type { SharedDatabaseBridge } from "../bridge.ts";
import type { MessagePortSharedDatabaseBridge } from "../message-port-client.ts";
import type { SingleConnectionSharedDatabaseBridge } from "../single-connection-client.ts";

type CommandSubscription<T> =
  T extends Command<unknown, [infer TArgs, AbortSignal]>
    ? TArgs extends { scope?: string; topic: string | null }
      ? Pick<TArgs, "scope" | "topic">
      : never
    : never;

// An unrestricted overload on any App entry point would admit an unknown topic.
type AppSubscription = CommandSubscription<
  | typeof setAblyLoop$
  | typeof setAblyPayloadLoop$
  | typeof setAblyInvalidationLoop$
  | typeof waitAblyLoopUntil$
  | typeof waitAblyPayloadLoopUntil$
  | typeof waitAblyInvalidationLoopUntil$
>;

declare const bridge: SharedDatabaseBridge;
declare const portBridge: MessagePortSharedDatabaseBridge;
declare const client: SingleConnectionSharedDatabaseBridge;

type UserBridgeTopic = Parameters<typeof bridge.subscribeRealtime<"user">>[2];
type UserPortTopic = Parameters<typeof portBridge.subscribeRealtime<"user">>[2];
type UserClientTopic = Parameters<typeof client.subscribeRealtime<"user">>[2];

test("App subscription entry points reject unregistered topics at compile time", () => {
  expectTypeOf<{
    topic: "unregisteredTopic";
  }>().not.toExtend<AppSubscription>();
  expectTypeOf<{
    scope: "user";
    topic: string;
  }>().not.toExtend<AppSubscription>();
  expectTypeOf<{
    scope: "org";
    topic: "getStartedRewardsChanged";
  }>().not.toExtend<AppSubscription>();
  expectTypeOf<{
    scope: "credential";
    topic: null;
  }>().not.toExtend<AppSubscription>();
});

test("Registered and dynamic topics retain their permitted scopes", () => {
  expectTypeOf<{
    topic: "getStartedRewardsChanged";
  }>().toExtend<AppSubscription>();
  expectTypeOf<{
    topic: `chatThreadArtifactsChanged:${string}`;
  }>().toExtend<AppSubscription>();
  expectTypeOf<{
    scope: "credential";
    topic: "morningBriefChanged";
  }>().toExtend<AppSubscription>();
  expectTypeOf<{
    scope: "org";
    topic: "modelPoliciesChanged";
  }>().toExtend<AppSubscription>();
  expectTypeOf<{
    scope: "run-output";
    topic: string;
  }>().toExtend<AppSubscription>();
});

test("Concrete bridges enforce the same registered user topics", () => {
  expectTypeOf<string>().not.toExtend<UserBridgeTopic>();
  expectTypeOf<"unregisteredTopic">().not.toExtend<UserBridgeTopic>();
  expectTypeOf<"getStartedRewardsChanged">().toExtend<UserBridgeTopic>();
  expectTypeOf<UserPortTopic>().toEqualTypeOf<UserBridgeTopic>();
  expectTypeOf<UserClientTopic>().toEqualTypeOf<UserBridgeTopic>();
});
