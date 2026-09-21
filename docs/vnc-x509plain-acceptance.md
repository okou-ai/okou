# X509Plain VNC acceptance

This record covers the disabled, preview-only X509Plain product path delivered
by pull request #35792. It is interoperability evidence for the exact versions
and configuration below, not production activation or support for another VNC
profile.

## Provenance

- Date: 2026-09-21 UTC.
- Tested pull request head and preview API commit:
  `0f12d831d222422e3530c6d0e200fe94030e2011`.
- Packaged Okou CLI: `9.349.1`.
- Current Runner: `0.206.0` on `dev-11.gcp.vm3.ai`, runner group
  `vm0/development-pr-35792`. Axiom observations for the positive interaction
  Run `5e92487b-7033-4bdb-aff3-2f9a68acead6` associated this Runner and API
  commit with the same Run.
- Server: `local-11.gcp.vm3.ai`, x86_64, Ubuntu package
  `tigervnc-standalone-server 1.13.1+dfsg-2build2`.
- Server profile: disposable `Xtigervnc` display, VeNCrypt `X509Plain`, a
  username/password PAM account, custom-CA server verification and a leaf
  certificate identifying `local-11.gcp.vm3.ai`.

The preview feature switches were enabled only for the disposable preview
owner. Because a GCP VM cannot reach its own public address through the tested
path, `dev-11` used one exact, temporary OUTPUT DNAT rule from the saved public
hostname and port to the private `local-11` listener. The saved host remained a
public destination and passed the Runner's public-destination policy; the rule
was acceptance plumbing, not product behavior.

## Positive path

A new preview chat thread and sandbox first ran `vnc session list` alone. Run
`38783792-b80b-430f-9a9a-4ba98e278188` returned
`{"outcome":"listed","sessions":[]}`. This separated the final test from an
earlier reused-sandbox RPC failure.

The owner then created one reusable `username_password` credential and one
`x509_plain` connection with custom-CA trust. The real Agent inventory returned
exactly the saved host with `authMethod=username_password` and
`securityType=x509_plain`. A shared session started, and a fresh 1280 by 720
screenshot had SHA-256
`428e972bee228f488ab1182756b9388767565173762428bbbbe7323d5c6fa2a8`.

The interaction used the screenshot's exact geometry, clicked coordinate
`(100, 20)` inside the visible xterm, typed a command that wrote
`X509Plain accepted`, and pressed Enter once. Both input operations returned
`sent`. After two seconds the screenshot changed to SHA-256
`b66e871b4dd22dd7cac817aa696af1a9835faffbc89e2e38de6327fbbc07259b`,
and an independent SSH readback on `local-11` verified the exact 19-byte marker.
The VNC session then returned `closed`.

An independent final check in Run `50391708-776f-4c84-a540-805dae7ca84a`
started and closed one shared session and returned
`{"outcome":"listed","sessions":[]}`.

## Cleanup and limitations

The final checks confirmed no VNC sessions, owner connections or owner
credentials remained. The disposable `local-11` process, systemd unit, PAM
account, certificate/key directory, input marker, TCP listener, X display lock
and upload staging directory were absent. The exact `dev-11` DNAT rule count was
zero, and the local certificate/key/password fixture was removed.

This acceptance covers one TigerVNC package, one current Runner and the exact
`username_password` / `x509_plain` profile. It does not enable `VncAccess`,
broaden its cohort, validate credentialless or other VNC profiles, or establish
a compatibility fallback.
