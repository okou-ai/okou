import type { UserNotification } from "@okouai/api-contracts/contracts/user-notifications";

type Sample = Pick<UserNotification, "title" | "summary" | "payload"> & {
  delivery_key: string;
};

// Fixed delivery keys preserve idempotency across preview redeploys.
const introductorySamples: Sample[] = [
  {
    title: "纯文案示例 · 欢迎使用站内信",
    summary: "一条没有图片的文字消息，看看排版和已读状态。",
    payload: {
      type: "rich_text",
      markdown:
        "## 欢迎来到站内信\n\n这是一条**纯文字测试消息**，用于预览阅读体验。\n\n- 打开列表不会标记已读\n- 点开消息后记录已读\n- 关闭弹窗后回到原来的消息\n\n你也可以在列表里一次性标记全部已读。",
    },
    delivery_key: "notifications-demo-20261106-text",
  },
  {
    title: "图文示例 · 把想法交给 Okou",
    summary: "图片、标题和正文会在同一个弹窗中展示。",
    payload: {
      type: "rich_text",
      markdown:
        "## 从一个想法开始\n\n把工作目标告诉 Okou，让每一次对话更接近结果。\n\n![图文排版示例](https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/aa7daace-8fa8-4319-a31a-bb55c8804382/template-card-illustration-cozy-parlor-512.jpg)\n\n**这是图文样式的测试内容。** 可以检查图片大小、文字间距与移动端阅读效果。",
    },
    delivery_key: "notifications-demo-20261106-image",
  },
  {
    title: "轮播示例 · 三步开始",
    summary: "共 3 页，点击底部圆点、左右箭头，或横向滑动来切换。",
    payload: {
      type: "carousel",
      pages: [
        {
          markdown:
            "## 1 · 说清你想完成什么\n\n从一个明确的目标开始，例如「帮我整理本周的工作进展」。\n\n![开始一个新任务](https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/d3633cfc-bb66-4cf1-9a9b-0c2ac53f12e4/template-card-illustration-ink-storefront-512.jpg)",
        },
        {
          markdown:
            "## 2 · 带上相关资料\n\n提供背景、参考文件和截止时间，让结果更贴合你的需要。\n\n![带上相关资料](https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/aa7daace-8fa8-4319-a31a-bb55c8804382/template-card-illustration-cozy-parlor-512.jpg)",
        },
        {
          markdown:
            "## 3 · 查看结果，继续推进\n\n需要调整时，直接在对话里补充反馈。也可以返回上一页，或关闭弹窗回到列表。\n\n![继续推进工作](https://static.vm0.io/vm0/artifact-templates/illustration/card-previews/139cd332-fe89-4326-aa8f-f7052b745bdf/template-card-illustration-tiny-wanderer-512.jpg)",
        },
      ],
    },
    delivery_key: "notifications-demo-20261106-carousel",
  },
];

const readingNotes = Array.from({ length: 18 }, (_, index) => {
  return `### ${index + 1} · 让工作更有条理\n\n把目标、相关资料和期望的结果写清楚。长消息可以在弹窗内部滚动阅读，关闭和轮播导航始终保持在原位。`;
}).join("\n\n");

const carousel = introductorySamples.find((sample) => {
  return sample.payload.type === "carousel";
})!;
if (carousel.payload.type !== "carousel")
  throw new Error("Carousel sample is required");
const carouselPages = carousel.payload.pages;
const topics = [
  "本周工作计划",
  "整理相关资料",
  "查看任务成果",
  "项目进度提醒",
  "协作小提示",
  "记录新的灵感",
];

// Three API pages (20 + 20 + 5) exercise repeated scroll loading. The first
// additional text and carousel also exercise independently scrollable bodies.
export const samples: Sample[] = [
  ...introductorySamples,
  ...Array.from({ length: 42 }, (_, index): Sample => {
    const template = introductorySamples[index % introductorySamples.length]!;
    const number = String(index + 4).padStart(2, "0");
    let payload = template.payload;
    if (index === 0) {
      payload = {
        type: "rich_text",
        markdown: `## 长文阅读示例\n\n${readingNotes}`,
      };
    } else if (index === 2) {
      payload = {
        type: "carousel",
        pages: [
          {
            markdown: "## 1 · 简短的开始\n\n不同长度的页面使用相同尺寸的弹窗。",
          },
          { markdown: `## 2 · 详细说明\n\n${readingNotes}` },
          ...carouselPages.slice(1),
          {
            markdown:
              "## 5 · 继续下一步\n\n可以通过圆点、箭头或左右滑动返回任意一页。",
          },
        ],
      };
    }
    return {
      title: `历史消息 ${number} · ${topics[index % topics.length]}`,
      summary: `第 ${number} 条预览消息，向下滚动可以继续查看更早的内容。`,
      payload,
      delivery_key: `notifications-demo-20261109-history-${number}`,
    };
  }),
];
