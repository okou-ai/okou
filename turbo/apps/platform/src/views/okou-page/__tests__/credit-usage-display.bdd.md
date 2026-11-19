# Credit usage display

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [credit-usage-display.test.tsx](credit-usage-display.test.tsx).

## credit-usage-display-001

Original test `Historical run usage appears when scrolling reveals its answer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/credit-usage-display.test.tsx#L130).

- **Given** A chat has seven completed turns, and settled usage totals 61 credits for the first run and 67 for the latest; each has a usage hint showing 999 credits.
- **When** The user opens the chat, then scrolls to reveal the first answer and opens its usage details.
- **Then** Initially, only the latest answer and its 67-credit button appear. Scrolling reveals the first answer and its 61-credit button; its details show 61, not the hint's 999, while the latest run's 67-credit button remains.

## credit-usage-display-002

Original test `A run shows settled usage only after its first usage hint arrives`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/credit-usage-display.test.tsx#L204).

- **Given** A completed run's answer is available, its settled ledger is 17 credits, and no usage hint has arrived.
- **When** The user opens the chat, then the run's first usage hint arrives with a payload totaling 999 credits.
- **Then** Before the hint arrives, the answer is visible and no credit-usage button appears. After the hint arrives, the button and details show the settled 17 credits, not 999.

## credit-usage-display-003

Original test `A new usage hint ID refreshes a run's displayed ledger even when the hint payload is unchanged`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/credit-usage-display.test.tsx#L242).

- **Given** A completed run has a usage hint and its displayed settled ledger totals 23 credits.
- **When** The ledger changes to 31 credits and a new usage hint arrives with the same payload as the first hint.
- **Then** The run's usage button and details refresh to 31 credits, and the old 23-credit button is absent.

## credit-usage-display-004

Original test `Ordinary output, run completion, and another run's hint preserve an unaffected run's displayed usage`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/credit-usage-display.test.tsx#L282).

- **Given** Run A has a usage hint and displays 41 settled credits; its ledger is later changed to 777. Run B has a separate ledger of 53 credits.
- **When** Run A receives ordinary output and a completion event, then Run B receives its prompt, answer, completion, and usage hint.
- **Then** Run A continues to display 41 credits after its output and completion. Run B's usage details show 53 credits, its answer is visible, and Run A still displays 41 credits.

## credit-usage-display-005

Original test `Credit usage preserves unknown historical model identifiers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/credit-usage-display.test.tsx#L357).

- **Given** A run's usage breakdown includes an uncataloged historical model identifier, acme/vision-pro, for 40 credits.
- **When** The user opens the run's usage details.
- **Then** The details display the model identifier acme/vision-pro.

## credit-usage-display-006

Original test `Credit usage formats unknown image-provider names for people to read`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/credit-usage-display.test.tsx#L380).

- **Given** A run's usage breakdown includes an image-provider identifier acme/vision-pro for 50 credits.
- **When** The user opens the run's usage details.
- **Then** The provider is displayed as “Acme Vision Pro.”

## credit-usage-display-007

Original test `Credit usage merges historical data services and new enrichment while preserving model and connector rows`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/credit-usage-display.test.tsx#L403).

- **Given** A run has 170 total credits across connector, social and commerce services, historical data services, and model rows. Its social and commerce provider-cost records enrich the service totals; its X connector has 12 credits, Data Search services include multiple providers, and model rows total 6 and 9 credits.
- **When** The user opens the run's usage details.
- **Then** The details show X at 12 credits, merged Data Search at 135, Legacy Data at 8, GPT 5.6 Sol at 6, and GPT 5.6 Luna at 9. The overall total remains 170 credits.

## credit-usage-display-008

Original test `Chat stays usable and shows no hint amount when settled usage cannot be read`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/credit-usage-display.test.tsx#L518).

- **Given** A chat answer is available and its usage hint reports 999 credits, but reading settled usage returns a not-found error.
- **When** The user opens the chat.
- **Then** The conversation remains usable and the answer is visible, but no credit-usage button showing 999 appears.

## credit-usage-display-009

Original test `Credit usage names each model row from the server catalog, keeping retired models and mapping upstream IDs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/credit-usage-display.test.tsx#L567).

- **Given** A run's usage includes retired Claude Opus 4.8 for 7 credits, an OpenRouter route with upstream ID openai/gpt-6-luna for 11 credits, and Claude Sonnet 4.6 for 12 credits. The server catalog names gpt-6-luna “Luna From Catalog.”
- **When** The user opens the run's usage details.
- **Then** The rows are named Claude Opus 4.8, Luna From Catalog, and Claude Sonnet 4.6 with their respective credits. The retired model is not renamed Claude Opus 5.5, Claude Sonnet 4.6 is not renamed Claude Sonnet 5.5, and the upstream ID is not shown as GPT 6 Luna.

## credit-usage-display-010

Original test `Credit usage shows managed labels and merges catalog aliases and Auto presets in en-US`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/credit-usage-display.test.tsx#L632).

- **Given** In en-US, a run's model usage lists Auto (1), Okou 1.0 (2), two aliases of Okou 1.0 (3 and 4), a removed operator preset (5), two aliases of GPT 6 Luna (6 and 7), three aliases of Claude Sonnet 4.6 (8, 9, and 10), Okou 1.0 Pro (11), and Okou 1.0 Max (12). It also has social-provider usage totaling 4 and commerce-provider usage of 17.
- **When** The user opens the run's usage details.
- **Then** The details show Data Search at 21, Auto at 15, GPT 6 Luna at 13, Claude Sonnet 4.6 at 27, Okou 1.0 Pro at 11, and Okou 1.0 Max at 12. The total is 99, the document language is en-US, and no @preset identifier is displayed.

## credit-usage-display-011

Original test `Credit usage preserves ambiguous upstream identifiers and uncataloged historical models`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/credit-usage-display.test.tsx#L704).

- **Given** A run's 10 model credits include 1 for an upstream ID shared by catalog routes for GPT 6 Luna and GPT 6 Sol, 2 for an uncataloged Claude Haiku identifier, and 7 split between disabled and historical Claude Opus 4.8 identifiers. One disabled route uses the upstream ID anthropic/disabled-opus.
- **When** The user opens the run's usage details.
- **Then** The shared upstream ID remains displayed verbatim with 1 credit, and the uncataloged identifier remains displayed verbatim with 2. The two Claude Opus identifiers merge into Claude Opus 4.8 with 7 credits; it is not renamed Claude Opus 5.5.

## credit-usage-display-012

Original test `Credit usage keeps internal model IDs hidden while the catalog loads`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/credit-usage-display.test.tsx#L772).

- **Given** A run's model usage includes openai/gpt-6-luna for 3 credits and a removed operator preset for 5; the server model catalog is still loading.
- **When** The user opens the run's usage details before the catalog loads, then the catalog becomes available.
- **Then** While loading, the model section headings appear but neither internal identifier is shown. Once loaded, the rows display GPT 6 Luna and Auto, with Auto showing 5 credits.
