const PRESENTATION_LANDING_PROMPT =
  "/gen presentation with template `html-ppt-playful-launch`, create a 15-slide launch deck for SproutPop, " +
  "a playful habit-building app for remote teams introducing a shared 30-day wellness challenge. Present it to people and culture leaders " +
  "with cover, agenda, launch story, audience pain points, product vision, feature tour, rollout timeline, activation moments, team, early metrics, " +
  "testimonials, pricing, and next steps. Make it saturated, joyful, idea-led, and structured.";

const PRESENTATION_SHOWCASE_URL =
  "https://cdn.vm0.io/artifacts/example/playful-launch-presentation.html";

const presentationOnboardingParams = new URLSearchParams({
  prompt: PRESENTATION_LANDING_PROMPT,
  showcase: PRESENTATION_SHOWCASE_URL,
  vm0_source: "presentation",
  landing_host: "www.okou.ai",
  landing_path: "/en/presentation",
  source_type: "direct",
});

const PRESENTATION_ONBOARDING_PATH = `/onboarding?${presentationOnboardingParams.toString()}`;
export const PRESENTATION_ONBOARDING_URL = `https://app.okou.ai${PRESENTATION_ONBOARDING_PATH}`;
