import { env, envSingleton } from "./env";

export const larkOfficialApp = envSingleton(() => {
  const appId = env("LARK_OFFICIAL_APP_ID");
  const appSecret = env("LARK_OFFICIAL_APP_SECRET");
  const verificationToken = env("LARK_OFFICIAL_VERIFICATION_TOKEN");
  const encryptKey = env("LARK_OFFICIAL_ENCRYPT_KEY");
  return appId && appSecret && verificationToken && encryptKey
    ? { appId, appSecret, verificationToken, encryptKey }
    : null;
});
