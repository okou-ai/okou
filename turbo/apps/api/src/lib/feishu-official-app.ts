import { env } from "./env";

export function feishuOfficialApp() {
  const appId = env("FEISHU_OFFICIAL_APP_ID");
  const appSecret = env("FEISHU_OFFICIAL_APP_SECRET");
  const verificationToken = env("FEISHU_OFFICIAL_VERIFICATION_TOKEN");
  const encryptKey = env("FEISHU_OFFICIAL_ENCRYPT_KEY");
  return appId && appSecret && verificationToken && encryptKey
    ? { appId, appSecret, verificationToken, encryptKey }
    : null;
}
