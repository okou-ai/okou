import { useTranslation } from "react-i18next";
import type { RsaAesProfile } from "../../signals/vnc-rsa-aes.ts";

// Literal selectors keep extraction complete and the dialog/card labels aligned.
export function useRsaAesProfileLabels(): Readonly<
  Record<RsaAesProfile, string>
> {
  const { t } = useTranslation();
  return {
    rsa_aes_ra2: t(($) => {
      return $.vnc.rsaAes.ra2Password;
    }),
    rsa_aes_ra2_256: t(($) => {
      return $.vnc.rsaAes.ra2256Password;
    }),
    rsa_aes_ra2ne: t(($) => {
      return $.vnc.rsaAes.ra2nePassword;
    }),
    rsa_aes_ra2ne_256: t(($) => {
      return $.vnc.rsaAes.ra2ne256Password;
    }),
    rsa_aes_ra2_username_password: t(($) => {
      return $.vnc.rsaAes.ra2UsernamePassword;
    }),
    rsa_aes_ra2_256_username_password: t(($) => {
      return $.vnc.rsaAes.ra2256UsernamePassword;
    }),
    rsa_aes_ra2ne_username_password: t(($) => {
      return $.vnc.rsaAes.ra2neUsernamePassword;
    }),
    rsa_aes_ra2ne_256_username_password: t(($) => {
      return $.vnc.rsaAes.ra2ne256UsernamePassword;
    }),
  };
}
