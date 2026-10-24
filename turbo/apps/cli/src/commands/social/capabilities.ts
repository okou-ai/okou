import {
  socialOperationBindings,
  socialPlatformSchema,
} from "@okouai/api-contracts/contracts/social-discovery";
import { isDataRouterToolEnabled } from "../../lib/command/paid-tools";
import {
  isJobOnlyPlatform,
  SOCIAL_JOB_ONLY_PLATFORMS,
  type SocialCommandPlatform,
} from "./intents";

const jobOperations: Partial<Record<SocialCommandPlatform, readonly string[]>> =
  {
    douyin: [
      "inspect",
      "posts",
      "search",
      "comments",
      "replies",
      "followers",
      "following",
    ],
    weibo: ["inspect", "posts", "search", "comments", "replies"],
    threads: ["inspect", "search"],
    wechat: ["inspect", "search", "comments"],
    xiaohongshu: ["inspect", "posts", "search", "comments"],
    instagram: ["inspect", "posts", "comments"],
    tiktok: ["inspect", "posts", "search", "comments"],
    youtube: ["inspect", "posts", "search", "comments", "transcript"],
    facebook: ["inspect", "posts", "search", "comments"],
    twitter: ["inspect", "posts", "search", "comments"],
  };

export function socialCapabilities(platform?: SocialCommandPlatform) {
  const platforms: readonly SocialCommandPlatform[] = platform
    ? [platform]
    : [...socialPlatformSchema.options, ...SOCIAL_JOB_ONLY_PLATFORMS];
  return platforms
    .map((selected) => {
      const entries = isJobOnlyPlatform(selected)
        ? []
        : socialOperationBindings(selected).filter((entry) => {
            return isDataRouterToolEnabled(
              entry.tool ?? "social_download_create",
            );
          });
      const jobs = isDataRouterToolEnabled("social_data_create")
        ? jobOperations[selected]
        : undefined;
      return {
        platform: selected,
        operations: [
          ...new Set([
            ...entries.map((entry) => {
              return entry.operation;
            }),
            ...(jobs ?? []),
          ]),
        ].sort(),
        tools: entries.map((entry) => {
          return {
            name: entry.tool ?? "social_download_create",
            operation: entry.operation,
            variant: entry.variant,
            inputs: entry.inputs,
          };
        }),
        ...(jobs
          ? {
              jobs: {
                operations: jobs,
                quote: "--dry-run",
                create: "--max-credits <credits>",
                get: "okou data social jobs get <job-id>",
              },
            }
          : {}),
        output: "Router JSON",
      };
    })
    .filter((entry) => {
      return entry.operations.length > 0 || entry.jobs !== undefined;
    });
}
