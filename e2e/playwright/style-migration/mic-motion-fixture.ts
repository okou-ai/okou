import assert from "node:assert/strict";
import type { BrowserContext, Page } from "@playwright/test";

import { fixtureBootstrap } from "./bootstrap";
import { installChatEmojiWorkerFixture } from "./chat-emoji-worker";

export const micMotionThreadId = "d7bc1e76-6c54-48ec-92ea-6c537f01f685";
const agentId = "6c68eef2-0294-4d83-a1cf-a8f8d8898b8d";
const timestamp = "2026-09-01T00:00:00.000Z";

interface MicMotionControl {
  releaseMicrophone(): void;
  setRms(value: number): void;
  state(): { getUserMediaCalls: number; released: boolean };
}

// The microphone is a browser boundary. Keep the production voice signals,
// component, events and CSS intact while supplying deterministic media input.
export async function installMicBrowserFixture(
  context: BrowserContext,
): Promise<void> {
  // Pass source text, not a callback: tsx/esbuild decorates serialized class
  // and arrow names with a Node-only helper that is unavailable in the page.
  await context.addInitScript({
    content: String.raw`
      (() => {
        let release;
        let getUserMediaCalls = 0;
        let released = false;
        let rms = 0;
        const microphoneReady = new Promise((resolve) => {
          release = resolve;
        });
        const stream = {
          getTracks: () => [{ stop: () => undefined }],
        };

        class TestMediaStreamAudioSource {
          connect() {}
          disconnect() {}
        }

        class TestAnalyser {
          fftSize = 1024;

          getFloatTimeDomainData(samples) {
            samples.fill(rms);
          }

          disconnect() {}
        }

        class TestAudioContext {
          resume() {
            return Promise.resolve();
          }

          close() {
            return Promise.resolve();
          }

          createMediaStreamSource() {
            return new TestMediaStreamAudioSource();
          }

          createAnalyser() {
            return new TestAnalyser();
          }
        }

        class TestMediaRecorder extends EventTarget {
          static isTypeSupported(type) {
            return type === "audio/webm";
          }

          ondataavailable = null;
          state = "inactive";

          constructor(_stream, options) {
            super();
            this.mimeType = options?.mimeType ?? "audio/webm";
          }

          start() {
            this.state = "recording";
          }

          requestData() {
            if (this.state === "recording") this.emitData();
          }

          stop() {
            if (this.state === "inactive") return;
            this.state = "inactive";
            this.emitData();
            this.dispatchEvent(new Event("stop"));
          }

          emitData() {
            const event = new Event("dataavailable");
            Object.defineProperty(event, "data", {
              value: new Blob(["mic-motion"], { type: this.mimeType }),
            });
            this.ondataavailable?.(event);
            this.dispatchEvent(event);
          }
        }

        Object.defineProperty(window, "__okouMicMotion", {
          configurable: true,
          value: {
            releaseMicrophone: () => {
              released = true;
              release?.();
            },
            setRms: (value) => {
              rms = value;
            },
            state: () => ({ getUserMediaCalls, released }),
          },
        });
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: {
            enumerateDevices: () => Promise.resolve([]),
            getUserMedia: () => {
              getUserMediaCalls += 1;
              return microphoneReady.then(() => stream);
            },
          },
        });
        Object.defineProperty(window, "MediaRecorder", {
          configurable: true,
          value: TestMediaRecorder,
        });
        Object.defineProperty(window, "AudioContext", {
          configurable: true,
          value: TestAudioContext,
        });
      })();
    `,
  });
}

export async function micBrowserFixtureState(page: Page) {
  return page.evaluate(() => {
    return (
      window as typeof window & { __okouMicMotion: MicMotionControl }
    ).__okouMicMotion.state();
  });
}

export async function releaseMicrophone(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as typeof window & { __okouMicMotion: MicMotionControl }
    ).__okouMicMotion.releaseMicrophone();
  });
}

export async function setMicrophoneRms(
  page: Page,
  value: number,
): Promise<void> {
  await page.evaluate((next) => {
    (
      window as typeof window & { __okouMicMotion: MicMotionControl }
    ).__okouMicMotion.setRms(next);
  }, value);
}

// API and bootstrap responses are the only network substitutions. The real
// deployed Router and composer own every state transition under observation.
export async function installMicMotionFixture(
  page: Page,
  appOrigin: string,
  apiOrigin: string,
  theme: "light" | "dark",
  failures: string[],
  chromiumProfile: string,
  appArtifactOrigin = appOrigin,
) {
  const agent = {
    agentId,
    ownerId: "mic-motion-test-owner",
    displayName: "Okou",
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "private",
  };
  const preferences = {
    timezone: "UTC",
    locale: "en-US",
    translationLanguage: "en",
    supportedLocales: ["en-US"],
    pinnedAgentIds: [],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: false,
    theme,
    colorTheme: "blue-horizon",
    captureNetworkBodiesRemaining: 0,
    voiceInputModel: null,
  };
  const switches = {
    voiceInputV2: false,
    _realAgentInPreview: false,
  };
  const thread = {
    id: micMotionThreadId,
    agentId,
    title: "Mic motion acceptance",
    sortAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    pinnedAt: null,
    renamedAt: timestamp,
    selectedModel: "claude-sonnet-4-6",
    serviceTier: null,
    computerUseHostId: null,
    cloudBrowserEnabled: false,
    selectedVideoModel: null,
    selectedImageModel: null,
  };
  const fixtures = (): Record<string, unknown> => ({
    "/api/user-preferences": preferences,
    "/api/feature-switches": { switches, effectiveSwitches: switches },
    "/api/onboarding/status": {
      needsOnboarding: false,
      onboardingComplete: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: agentId,
      defaultAgentMetadata: {
        displayName: agent.displayName,
        avatarUrl: null,
        sound: null,
      },
    },
    "/api/org": {
      id: "mic-motion-test-org",
      name: "Mic Motion TEST",
      role: "admin",
    },
    "/api/org/logo": { logoUrl: null, hasImage: false },
    "/api/agents": [agent],
    [`/api/agents/${agentId}`]: agent,
    [`/api/agents/${agentId}/user-connectors`]: {
      enabledConnectorSlugs: [],
    },
    [`/api/agents/${agentId}/custom-connectors`]: { grants: [] },
    "/api/connector-catalog/discovery": {
      connectors: [],
      totalConnectorCount: 0,
      categoryConnectorCounts: {},
    },
    "/api/custom-connectors": { connectors: [] },
    "/api/indicators": { agents: {}, threads: {} },
    "/api/computer-use/hosts": { hosts: [] },
    "/api/chat-thread-drafts": { draftThreadIds: [] },
    "/api/chat-threads/snapshot": {
      chatThreads: [thread],
      latestEventId: null,
      latestSeqId: null,
    },
    "/api/chat-threads/events": { events: [], hasMore: false },
    [`/api/chat-threads/${micMotionThreadId}`]: {
      lastReadAt: timestamp,
      cancellationRecoveryPending: false,
    },
    [`/api/chat-threads/${micMotionThreadId}/metadata`]: thread,
    [`/api/chat-threads/${micMotionThreadId}/draft`]: {
      draftUserMessage: null,
      draftAttachments: null,
    },
    [`/api/chat-threads/${micMotionThreadId}/event-rows`]: {
      rows: [],
      cursor: { lastEventId: null, lastSeqId: 0 },
      hasMore: false,
    },
    [`/api/chat-threads/${micMotionThreadId}/artifacts`]: { runs: [] },
    [`/api/chat-threads/${micMotionThreadId}/workflow-automations`]: {
      automations: [],
    },
    "/api/billing/status": {
      tier: "pro",
      showUsagePack: false,
      credits: 2000,
      onboardingPaymentPending: false,
      subscriptionStatus: "active",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
      creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
      creditBreakdown: [],
      creditGrants: [],
      concurrencyLimit: 1,
      concurrencySubscriptions: [],
    },
    "/api/voice-io/quota": { allowed: true, count: 0, limit: 10 },
  });
  let releaseTranscription: (() => void) | undefined;
  const transcriptionReady = new Promise<void>((resolve) => {
    releaseTranscription = resolve;
  });
  const worker = await installChatEmojiWorkerFixture(
    chromiumProfile,
    apiOrigin,
    fixtures,
    failures,
  );
  await fixtureBootstrap(page, appOrigin, fixtures, appArtifactOrigin);
  await page.context().route(
    (url) => url.origin === apiOrigin,
    async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const method = request.method();
      try {
        if (pathname === "/api/voice-io/stt") {
          assert.equal(method, "POST");
          await transcriptionReady;
          await route.fulfill({ json: { text: "Mic motion transcript" } });
        } else if (
          pathname === `/api/chat-threads/${micMotionThreadId}/event-snapshot`
        ) {
          await route.fulfill({
            status: 404,
            json: {
              error: {
                code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
                message: "Chat event snapshot not found",
              },
            },
          });
        } else if (
          pathname === `/api/chat-threads/${micMotionThreadId}/mark-read`
        ) {
          await route.fulfill({ json: { lastReadAt: timestamp, unreads: {} } });
        } else if (pathname === "/api/chat/events/catch-up") {
          await route.fulfill({
            json: {
              events: { [micMotionThreadId]: [] },
              notFoundThreads: [],
            },
          });
        } else if (
          pathname === "/api/user-preferences/initialize" &&
          method === "POST"
        ) {
          assert.deepEqual(request.postDataJSON(), { timezone: "UTC" });
          await route.fulfill({ json: preferences });
        } else if (pathname === "/api/user-preferences" && method === "POST") {
          const update: Record<string, unknown> = request.postDataJSON();
          for (const [key, value] of Object.entries(update)) {
            assert.deepEqual(value, Reflect.get(preferences, key));
          }
          await route.fulfill({ json: preferences });
        } else if (pathname === "/api/attribution/signup") {
          assert.equal(method, "POST");
          await route.fulfill({
            json: { recorded: false, googleAdsAccountId: null },
          });
        } else if (fixtures()[pathname] !== undefined && method === "GET") {
          await route.fulfill({ json: fixtures()[pathname] });
        } else {
          assert(
            method === "GET" || pathname === "/api/realtime/token",
            `Unexpected write: ${method} ${pathname}`,
          );
          await route.fallback();
        }
      } catch (error) {
        failures.push(`mic-motion fixture: ${String(error)}`);
        await route.fulfill({ status: 500, body: "Fixture rejected request" });
      }
    },
  );
  return {
    ...worker,
    releaseTranscription: () => releaseTranscription?.(),
  };
}
