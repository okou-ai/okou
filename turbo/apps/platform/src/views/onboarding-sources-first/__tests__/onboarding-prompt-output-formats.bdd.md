# Onboarding prompt output formats

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-prompt-output-formats.test.tsx](onboarding-prompt-output-formats.test.tsx).

## onboarding-prompt-output-formats-001

Original test `selects a task-matched default for Create a presentation from my topic or files. Ask me about the audience and goal.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt contains a request to create a presentation and asks about audience and goal.
- **When** The prompt loads.
- **Then** Presentation is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-002

Original test `selects a task-matched default for Analyze the social profiles or posts I share. Summarize the evidence and recommend next steps.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt asks to analyze shared social profiles or posts and summarize evidence and next steps.
- **When** The prompt loads.
- **Then** Document is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-003

Original test `selects a task-matched default for Find people or businesses that match my criteria, using public professional sources. Explain why each result fits.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt asks to find matching people or businesses from public professional sources and explain the fit.
- **When** The prompt loads.
- **Then** People shortlist is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-004

Original test `selects a task-matched default for Create an image from my brief. Ask me about the subject, style, and dimensions.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt asks to create an image from a brief and asks about subject, style, and dimensions.
- **When** The prompt loads.
- **Then** Image is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-005

Original test `selects a task-matched default for Build a landing page for my consulting business.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt asks for a consulting-business landing page.
- **When** The prompt loads.
- **Then** Website is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-006

Original test `selects a task-matched default for Research the market for AI assistants and compare competitors.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt asks for market research and competitor comparison on AI assistants.
- **When** The prompt loads.
- **Then** Research brief is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-007

Original test `selects a task-matched default for /gen presentation, create a pitch deck about image generation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt uses the `/gen presentation` directive for a pitch deck about image generation.
- **When** The prompt loads.
- **Then** Presentation is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-008

Original test `selects a task-matched default for /gen website create a portfolio for a presentation designer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt uses the `/gen website` directive to request a portfolio for a presentation designer.
- **When** The prompt loads.
- **Then** Website is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-009

Original test `selects a task-matched default for Create a report about image generation trends.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt asks for a report about image-generation trends.
- **When** The prompt loads.
- **Then** Document is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-010

Original test `selects a task-matched default for /gen document compare three marketing strategies`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt uses the `/gen document` directive to compare three marketing strategies.
- **When** The prompt loads.
- **Then** Document is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-011

Original test `selects a task-matched default for Research AI assistants and return a document with the findings.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt asks for AI-assistant research returned as a document.
- **When** The prompt loads.
- **Then** Document is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-012

Original test `selects a task-matched default for Compare these proposals and present the results as a PDF.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt asks to compare proposals and present the results as a PDF.
- **When** The prompt loads.
- **Then** Document is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-013

Original test `selects a task-matched default for 调研市场并整理成一份文档。`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt in Chinese asks for market research organized into a document.
- **When** The prompt loads.
- **Then** Document is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-014

Original test `selects a task-matched default for Review our website traffic and recommend improvements.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt asks to review website traffic and recommend improvements.
- **When** The prompt loads.
- **Then** Document is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-015

Original test `selects a task-matched default for Research website builders for a small business.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt asks to research website builders for a small business.
- **When** The prompt loads.
- **Then** Research brief is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-016

Original test `selects a task-matched default for Find creators who reach small business owners.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt asks to find creators who reach small-business owners.
- **When** The prompt loads.
- **Then** People shortlist is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-017

Original test `selects a task-matched default for 帮我制作一份产品介绍PPT`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt in Chinese asks for a product-introduction presentation.
- **When** The prompt loads.
- **Then** Presentation is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-018

Original test `selects a task-matched default for 生成一张产品宣传海报`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt in Chinese asks to generate a product-promotional poster.
- **When** The prompt loads.
- **Then** Image is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-019

Original test `selects a task-matched default for 为咨询业务搭建一个网站`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt in Chinese asks to build a website for a consulting business.
- **When** The prompt loads.
- **Then** Website is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-020

Original test `selects a task-matched default for 寻找适合推广办公工具的达人`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt in Chinese asks to find influencers suitable for promoting office tools.
- **When** The prompt loads.
- **Then** People shortlist is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-021

Original test `selects a task-matched default for 调研AI助手的市场和竞争对手`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt in Chinese asks to research the AI-assistant market and competitors.
- **When** The prompt loads.
- **Then** Research brief is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-022

Original test `selects a task-matched default for 分析上周广告效果并提出改进建议`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt in Chinese asks to analyze last week's advertising results and suggest improvements.
- **When** The prompt loads.
- **Then** Document is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-023

Original test `selects a task-matched default for Turn these notes into a 10-slide presentation.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt asks to turn notes into a 10-slide presentation.
- **When** The prompt loads.
- **Then** Presentation is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-024

Original test `selects a task-matched default for 把这些资料整理成一份PPT。`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt in Chinese asks to organize provided materials into a presentation.
- **When** The prompt loads.
- **Then** Presentation is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-025

Original test `selects a task-matched default for Don't create a presentation. Create a report with the findings.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt explicitly says not to create a presentation and instead requests a report with findings.
- **When** The prompt loads.
- **Then** Document is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-026

Original test `selects a task-matched default for Do not create a report; instead create a presentation.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt explicitly says not to create a report and instead requests a presentation.
- **When** The prompt loads.
- **Then** Presentation is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-027

Original test `selects a task-matched default for 不要制作PPT，写一份报告。`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt in Chinese says not to make a presentation and requests a report.
- **When** The prompt loads.
- **Then** Document is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-028

Original test `selects a task-matched default for Do not return JSON. Create a report.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt says not to return JSON and requests a report.
- **When** The prompt loads.
- **Then** Document is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-029

Original test `selects a task-matched default for Find people who can help me design a website.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt asks to find people who can help design a website.
- **When** The prompt loads.
- **Then** People shortlist is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-030

Original test `selects a task-matched default for Find designers to create a presentation.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt asks to find designers to create a presentation.
- **When** The prompt loads.
- **Then** People shortlist is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-031

Original test `selects a task-matched default for 找能帮我设计网站的人`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt in Chinese asks to find people who can help design a website.
- **When** The prompt loads.
- **Then** People shortlist is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-032

Original test `selects a task-matched default for Find people who can design a website. Present the shortlist as a report.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L114).

- **Given** The onboarding prompt asks to find people who can design a website and return the shortlist as a report.
- **When** The prompt loads.
- **Then** Document is selected by default. Clearing the selection leaves the prompt unchanged, and editing the prompt does not select Presentation again.

## onboarding-prompt-output-formats-033

Original test `preserves an explicit response contract: What is 1 + 2? Reply with only the number.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L143).

- **Given** The onboarding prompt asks what 1 + 2 is and explicitly requests only the number in reply.
- **When** The prompt loads and the user continues to the first chat.
- **Then** The prompt remains unchanged, Document is not selected by default, and the submitted chat prompt exactly matches the original prompt.

## onboarding-prompt-output-formats-034

Original test `preserves an explicit response contract: What is 1 + 2? Only return the number.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L143).

- **Given** The onboarding prompt asks what 1 + 2 is and explicitly says to only return the number.
- **When** The prompt loads and the user continues to the first chat.
- **Then** The prompt remains unchanged, Document is not selected by default, and the submitted chat prompt exactly matches the original prompt.

## onboarding-prompt-output-formats-035

Original test `preserves an explicit response contract: Compare these two records. Return valid JSON.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L143).

- **Given** The onboarding prompt asks to compare two records and return valid JSON.
- **When** The prompt loads and the user continues to the first chat.
- **Then** The prompt remains unchanged, Document is not selected by default, and the submitted chat prompt exactly matches the original prompt.

## onboarding-prompt-output-formats-036

Original test `preserves an explicit response contract: 计算1加2，只回复数字。`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L143).

- **Given** The onboarding prompt is “计算1加2，只回复数字。”.
- **When** The user continues to the first chat without choosing a format.
- **Then** The prompt is submitted unchanged; Document is not selected by default.

## onboarding-prompt-output-formats-037

Original test `preserves an explicit response contract: Create a report on the campaign. Reply with only one sentence.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L143).

- **Given** The onboarding prompt is “Create a report on the campaign. Reply with only one sentence.”
- **When** The user continues to the first chat without choosing a format.
- **Then** The prompt is submitted unchanged; Document is not selected by default.

## onboarding-prompt-output-formats-038

Original test `an explicit response contract can still be changed with the format controls`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L162).

- **Given** The onboarding prompt is “What is 1 + 2? Reply with only the number.” and no output format is selected.
- **When** The user selects Document, then clears the selection.
- **Then** The prompt remains unchanged throughout; Document becomes selected and then is cleared.

## onboarding-prompt-output-formats-039

Original test `the default format reaches the first chat for Create a presentation for my next board meeting.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L183).

- **Given** The onboarding prompt is “Create a presentation for my next board meeting.” and its task-matched format is selected by default.
- **When** The user continues to the first chat.
- **Then** The submitted prompt appends “Present the findings as a concise presentation with key results, recommendations, and next steps.” after a blank line.

## onboarding-prompt-output-formats-040

Original test `the default format reaches the first chat for Review my latest campaign and recommend three improvements.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L183).

- **Given** The onboarding prompt is “Review my latest campaign and recommend three improvements.” and its task-matched format is selected by default.
- **When** The user continues to the first chat.
- **Then** The submitted prompt appends “Create a complete document with the results in the requested file format (Markdown by default). Upload it as an artifact and include the working artifact link in your final response.” after a blank line.

## onboarding-prompt-output-formats-041

Original test `a shared prompt separates its format before selecting Presentation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L205).

- **Given** A shared prompt contains the task followed by the presentation instruction on a separate paragraph; Presentation is selected.
- **When** The user selects Presentation and continues.
- **Then** The task remains separate from the instruction, and the submitted prompt contains the task followed once by the presentation instruction.

## onboarding-prompt-output-formats-042

Original test `a shared prompt separates its format before selecting Document`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L205).

- **Given** A shared prompt contains the task followed by the presentation instruction on a separate paragraph; Presentation is selected.
- **When** The user selects Document and continues.
- **Then** The task remains separate from the instruction, and the submitted prompt contains the task followed once by the Document instruction.

## onboarding-prompt-output-formats-043

Original test `a shared prompt separates its format before selecting Clear selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L205).

- **Given** A shared prompt contains the task followed by the presentation instruction on a separate paragraph; Presentation is selected.
- **When** The user clears the format selection and continues.
- **Then** The task remains unchanged and is submitted without a format instruction.

## onboarding-prompt-output-formats-044

Original test `prompt links keep the task separate and submit only the latest selected format (mobile: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L232).

- **Given** On desktop onboarding, the task is selected for Document by default and the tool-connection region is present.
- **When** The user selects Image, Website, Document, Research brief, People shortlist, then Presentation, and clicks Next.
- **Then** The task stays unchanged while choosing formats, and the first chat receives the task followed only by the presentation instruction.

## onboarding-prompt-output-formats-045

Original test `prompt links keep the task separate and submit only the latest selected format (mobile: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L232).

- **Given** On mobile source onboarding, the task is selected for Document by default and the tool-connection region is present.
- **When** The user selects Image, Website, Document, Research brief, People shortlist, then Presentation, and clicks Start task.
- **Then** The task stays unchanged while choosing formats, and the first chat receives the task followed only by the presentation instruction.

## onboarding-prompt-output-formats-046

Original test `switching and clearing formats preserve the edited task and submit it unchanged`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L278).

- **Given** The user edits the task to “Please Review my latest campaign and recommend three improvements.\n\nUse plain English.”
- **When** The user switches to Presentation, switches to Document, clears the selection, and continues.
- **Then** The edited task is preserved through each selection change and submitted unchanged, without a format instruction.

## onboarding-prompt-output-formats-047

Original test `editing the task preserves the selected format for submission`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L302).

- **Given** The task is selected for Document by default.
- **When** The user selects Presentation, edits the task to “Draft a customer update.”, and continues.
- **Then** The edited task is submitted followed by the presentation instruction; Presentation remains selected after editing.

## onboarding-prompt-output-formats-048

Original test `long landing-page prompts can choose a format without being truncated`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L324).

- **Given** The onboarding prompt contains the campaign task followed by “Keep the recommendations actionable.” repeated 40 times.
- **When** The user selects Presentation and continues.
- **Then** The full prompt remains intact and is submitted followed by the presentation instruction.

## onboarding-prompt-output-formats-049

Original test `landing-page formats preselect both outputs and submit each once (mobile: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L349).

- **Given** On desktop, the URL requests Website, People shortlist, Website again, and an invalid format; Website and People shortlist are preselected, while Document is not.
- **When** The user edits the task to include “Focus on US agencies.” and clicks Next.
- **Then** The first chat receives the edited task followed once by the Website and People shortlist instructions, in that order.

## onboarding-prompt-output-formats-050

Original test `landing-page formats preselect both outputs and submit each once (mobile: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L349).

- **Given** On mobile, the URL requests Website, People shortlist, Website again, and an invalid format; Website and People shortlist are preselected, while Document is not.
- **When** The user edits the task to include “Focus on US agencies.” and clicks Start task.
- **Then** The first chat receives the edited task followed once by the Website and People shortlist instructions, in that order.

## onboarding-prompt-output-formats-051

Original test `removing one preselected format keeps the other and preserves the editable request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L383).

- **Given** Website and People shortlist are preselected from the URL, and the editable request contains the campaign task.
- **When** The user removes Website and continues.
- **Then** The request remains unchanged, Website is unselected, People shortlist remains selected, and only its instruction is appended to the submitted task.

## onboarding-prompt-output-formats-052

Original test `clearing preselected formats submits only the task`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L407).

- **Given** Website and People shortlist are preselected from the URL, and the editable request contains the campaign task.
- **When** The user clears the selections and continues.
- **Then** The request remains unchanged and is submitted without output instructions.

## onboarding-prompt-output-formats-053

Original test `invalid format IDs retain the task-shaped default`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L423).

- **Given** The URL requests unknown and uppercase WEBSITE format IDs for the campaign task.
- **When** The onboarding prompt loads.
- **Then** Document remains selected as the task-matched default.

## onboarding-prompt-output-formats-054

Original test `all selected output instructions count toward the submission limit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L431).

- **Given** The task has length 20,000 minus the Website instruction length minus two characters, and Website and People shortlist are selected.
- **When** The user removes People shortlist.
- **Then** Next changes from disabled to enabled as the selected output instructions fit within the submission limit.

## onboarding-prompt-output-formats-055

Original test `shared multi-output requests separate suffixes without duplicating them`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L439).

- **Given** A shared prompt contains the campaign task followed by Website and People shortlist instructions, each in a separate paragraph.
- **When** The user continues to the first chat.
- **Then** The task is separated from both selected outputs, and the submitted prompt matches the original with each instruction appearing once.

## onboarding-prompt-output-formats-056

Original test `disabling multiple outputs retains the previous task-shaped selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-prompt-output-formats.test.tsx#L463).

- **Given** Website and People shortlist are requested in the URL while multiple outputs are disabled.
- **When** The onboarding prompt loads.
- **Then** The task remains unchanged, Document is selected by default, and Website and People shortlist are not selected.
