import { expect, test } from "vitest";
import { detectComposerGenerationIntent } from "../composer-generation-intent.ts";

test.each([
  ["presentation", "presentation"],
  ["Slides", "presentation"],
  ["slide", "presentation"],
  ["ＰＰＴＸ", "presentation"],
  ["image", "image"],
  ["illustrations", "image"],
  ["doc", "document"],
  ["documents", "document"],
  ["report", "report"],
  ["财报", "report"],
  ["Create slides about image recognition", "presentation"],
  ["Please generate a report in docx", "report"],
  ["Can you make a presentation for our team?", "presentation"],
  ["Draw an illustration of a coffee shop", "image"],
  ["请帮我生成一份报告", "report"],
  ["制作一份关于图片识别的演示文稿", "presentation"],
  ["生成一张图片", "image"],
  ["请写一份文档", "document"],
] as const)("Detect the requested output in %s", (text, intent) => {
  expect(detectComposerGenerationIntent(text)).toBe(intent);
});

test.each([
  "slider",
  "Docker",
  "image.png",
  "report.pdf",
  "https://example.com/slides",
  "`image`",
  '"report"',
  "> presentation",
  "```text\nimage\n```",
  "What is an image?",
  "Analyze this image",
  "Summarize the report",
  "report a bug",
  "Please report a bug",
  "Do not generate an image",
  "不要生成图片",
  "Create no images",
  "Create slides and an image",
  "Create a document and a report",
  "生成图片和演示文稿",
  "Create slides about AI and generate an image",
  "Create image recognition code",
  "Generate a Docker image",
])("Do not infer a single generation output from %s", (text) => {
  expect(detectComposerGenerationIntent(text)).toBeNull();
});
