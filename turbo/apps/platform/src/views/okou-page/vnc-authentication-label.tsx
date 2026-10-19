import { useTranslation } from "react-i18next";
import type { VncAuthMethod } from "../../signals/vnc.ts";
export function VncAuthenticationLabel({
  method,
}: {
  readonly method: VncAuthMethod;
}) {
  const { t } = useTranslation();
  if (method === "rsa_aes_password" || method === "rsa_aes_username_password") {
    return t(($) => {
      return method === "rsa_aes_password"
        ? $.vnc.rsaAes.passwordMethod
        : $.vnc.rsaAes.usernamePasswordMethod;
    });
  }
  switch (method) {
    case "client_certificate": {
      return t(($) => {
        return $.vnc.security.clientCertificateNone;
      });
    }
    case "client_certificate_vnc_password": {
      return t(($) => {
        return $.vnc.security.clientCertificateVnc;
      });
    }
    case "none": {
      return t(($) => {
        return $.vnc.security.x509None;
      });
    }
    case "vnc_password": {
      return t(($) => {
        return $.vnc.credential.method;
      });
    }
    case "username_password": {
      return t(($) => {
        return $.vnc.credential.usernamePasswordMethod;
      });
    }
    case "qemu_scram_sha256": {
      return t(($) => {
        return $.vnc.security.qemuX509Sasl;
      });
    }
    case "qemu_kerberos_ticket": {
      return t(($) => {
        return $.vnc.kerberos.ticket;
      });
    }
    case "qemu_kerberos_keytab": {
      return t(($) => {
        return $.vnc.kerberos.keytab;
      });
    }
    case "qemu_kerberos_password": {
      return t(($) => {
        return $.vnc.kerberos.password;
      });
    }
    case "apple_dh_username_password": {
      return t(($) => {
        return $.vnc.credential.appleDhMethod;
      });
    }
    case "apple_srp_username_password": {
      return t(($) => {
        return $.vnc.credential.appleSrpMethod;
      });
    }
    case "apple_rsa_srp_username_password": {
      return t(($) => {
        return $.vnc.credential.appleRsaSrpMethod;
      });
    }
  }
  void (method satisfies never);
  return null;
}
