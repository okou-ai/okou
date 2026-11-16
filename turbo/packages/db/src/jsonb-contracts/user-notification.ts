/** Historical storage only; the in-app notification runtime has been retired. */
export type UserNotificationPayload =
  | {
      readonly type: "rich_text";
      readonly markdown: string;
      readonly automationDisabled?: {
        readonly automationId: string;
        readonly workflowId: string;
        readonly workspaceId: string;
        readonly workspaceName?: string;
        readonly automationName: string;
        readonly disabledAt: string;
        readonly consecutiveFailures: number;
        readonly recoveryScheduled: boolean;
      };
    }
  | {
      readonly type: "carousel";
      readonly pages: readonly { readonly markdown: string }[];
    };
