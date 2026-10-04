//! Public non-authentic canaries: process/structure/ownership, not mutual GSS interop.
#![cfg(test)]
pub mod common;
use common::{credentials, credentials_with_ticket, policy, principal, root, ticket};
use kerberos_worker::{Credentials, Error, NoKdc, Source, TicketPolicy};
use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::time::Instant;

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; strict matrix job"]
async fn encoded_ticket_target_mismatch_refuses_before_token_and_cleans_private_tree() {
    let root = root();
    let path = root.path().canonicalize().unwrap();
    let result = kerberos_worker::open(
        &path,
        credentials("other"),
        policy(),
        Instant::now() + Duration::from_secs(10),
        &mut NoKdc,
    )
    .await;
    assert!(matches!(result, Err(Error::IdentityMismatch)), "{result:?}");
    // Failure is delivered before the reaper may finish; wait only for independent cleanup.
    let until = Instant::now() + Duration::from_secs(2);
    while fs::read_dir(&path).unwrap().next().is_some() && Instant::now() < until {
        tokio::task::yield_now().await;
    }
    assert_eq!(fs::read_dir(path).unwrap().count(), 0);
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; strict matrix job"]
async fn matching_public_canary_opens_explicit_offline_handle_and_reaps_on_close() {
    let root = root();
    let path = root.path().canonicalize().unwrap();
    let (mut context, status) = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        Instant::now() + Duration::from_secs(10),
        &mut NoKdc,
    )
    .await
    .unwrap();
    let id = context.process_id();
    assert!(std::path::Path::new(&format!("/proc/{id}")).exists());
    assert!(!status.renewable);
    assert!(status.expires_at > Instant::now());
    assert_eq!(fs::read_dir(&path).unwrap().count(), 0);
    assert_eq!(
        context.renew(&mut NoKdc).await.unwrap_err(),
        Error::Authority
    );
    let step = context.step(None, &mut NoKdc).await.unwrap();
    assert!(!step.complete);
    assert!(step.token.as_ref().is_some_and(|token| !token.is_empty()));
    // The deliberately non-authentic AP-REQ is never delivered to a peer.
    drop(step);
    context.close().await.unwrap();
    assert!(!std::path::Path::new(&format!("/proc/{id}")).exists());
    assert_eq!(fs::read_dir(path).unwrap().count(), 0);
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; strict matrix job"]
async fn two_actual_processes_hold_capacity_until_owned_close_and_drop_cleanup() {
    let root = root();
    let path = root.path().canonicalize().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let (first, _) = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        deadline,
        &mut NoKdc,
    )
    .await
    .unwrap();
    let (second, _) = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        deadline,
        &mut NoKdc,
    )
    .await
    .unwrap();
    let second_id = second.process_id();
    let ids = [first.process_id(), second_id];
    let third = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        Instant::now() + Duration::from_millis(40),
        &mut NoKdc,
    )
    .await;
    assert!(matches!(third, Err(Error::Deadline)));
    for id in ids {
        assert!(std::path::Path::new(&format!("/proc/{id}")).exists());
    }
    first.close().await.unwrap();
    let (replacement, _) = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        deadline,
        &mut NoKdc,
    )
    .await
    .unwrap();
    let replacement_id = replacement.process_id();
    drop(second);
    replacement.close().await.unwrap();
    let until = Instant::now() + Duration::from_secs(2);
    while std::path::Path::new(&format!("/proc/{second_id}")).exists() && Instant::now() < until {
        tokio::task::yield_now().await;
    }
    for id in ids.into_iter().chain([replacement_id]) {
        assert!(!std::path::Path::new(&format!("/proc/{id}")).exists());
    }
    assert_eq!(fs::read_dir(path).unwrap().count(), 0);
}

#[tokio::test]
async fn supported_or_explicitly_unavailable_bootstrap_never_uses_another_backend() {
    let root = root();
    let path = root.path().canonicalize().unwrap();
    let result = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        Instant::now() + Duration::from_secs(10),
        &mut NoKdc,
    )
    .await;
    match result {
        Ok((context, _)) => {
            context.close().await.unwrap();
            println!("owner bootstrap: supported");
        }
        Err(Error::Unavailable) => {
            println!("owner bootstrap: explicitly unavailable");
        }
        other => panic!("{other:?}"),
    }
    let until = Instant::now() + Duration::from_secs(2);
    while fs::read_dir(&path).unwrap().next().is_some() && Instant::now() < until {
        tokio::task::yield_now().await;
    }
    assert_eq!(fs::read_dir(path).unwrap().count(), 0);
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; strict matrix job"]
async fn exact_service_realm_case_and_malformed_encoded_tickets_refuse_before_token() {
    let root = root();
    let path = root.path().canonicalize().unwrap();
    let replace = |from: &[u8], to: &[u8]| {
        let mut bytes = ticket("fixture");
        let index = bytes
            .windows(from.len())
            .position(|part| part == from)
            .unwrap();
        bytes
            .get_mut(index..index + from.len())
            .unwrap()
            .copy_from_slice(to);
        bytes
    };
    for encoded in [
        replace(b"vnc", b"ssh"),
        replace(b"ISSUE37612.INVALID", b"ISSUE37613.INVALID"),
        ticket("Fixture"),
    ] {
        let result = kerberos_worker::open(
            &path,
            credentials_with_ticket(encoded),
            policy(),
            Instant::now() + Duration::from_secs(10),
            &mut NoKdc,
        )
        .await;
        assert!(matches!(result, Err(Error::IdentityMismatch)), "{result:?}");
    }
    let mut truncated = ticket("fixture");
    truncated.pop();
    let mut suffix = ticket("fixture");
    suffix.push(0);
    let mut concatenated = ticket("fixture");
    concatenated.extend(ticket("fixture"));
    for encoded in [
        truncated,
        b"not a Ticket ASN.1 object".to_vec(),
        suffix,
        concatenated,
    ] {
        let result = kerberos_worker::open(
            &path,
            credentials_with_ticket(encoded),
            policy(),
            Instant::now() + Duration::from_secs(10),
            &mut NoKdc,
        )
        .await;
        assert!(matches!(result, Err(Error::Invalid)), "{result:?}");
    }
    let until = Instant::now() + Duration::from_secs(2);
    while fs::read_dir(&path).unwrap().next().is_some() && Instant::now() < until {
        tokio::task::yield_now().await;
    }
    assert_eq!(fs::read_dir(path).unwrap().count(), 0);
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; strict matrix job"]
async fn cancellation_while_authority_is_pending_reaps_even_when_context_survives() {
    use kerberos_worker::KdcExchange;
    use zeroize::Zeroizing;
    struct Pending;
    impl KdcExchange for Pending {
        async fn authorize(&mut self) -> Result<(), Error> {
            std::future::pending().await
        }
        async fn exchange(&mut self, _: &str, _: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
            panic!("offline exchange must never be polled")
        }
    }
    let root = root();
    let path = root.path().canonicalize().unwrap();
    let (mut context, _) = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        Instant::now() + Duration::from_secs(10),
        &mut NoKdc,
    )
    .await
    .unwrap();
    let id = context.process_id();
    assert!(
        tokio::time::timeout(Duration::from_millis(20), context.step(None, &mut Pending))
            .await
            .is_err()
    );
    // Keep Context alive: dropping only the operation must still abort actual native work.
    context.close().await.unwrap();
    assert!(!std::path::Path::new(&format!("/proc/{id}")).exists());
    assert_eq!(fs::read_dir(path).unwrap().count(), 0);
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; strict matrix job"]
async fn actual_stopped_io_and_idle_crash_are_reaped_before_replacement_admission() {
    use rustix::process::{Pid, Signal, kill_process};
    let root = root();
    let path = root.path().canonicalize().unwrap();
    for stopped in [true, false] {
        let (mut context, _) = kerberos_worker::open(
            &path,
            credentials("fixture"),
            policy(),
            Instant::now() + Duration::from_secs(10),
            &mut NoKdc,
        )
        .await
        .unwrap();
        let id = context.process_id();
        let pid = Pid::from_raw(i32::try_from(id).unwrap()).unwrap();
        kill_process(pid, if stopped { Signal::STOP } else { Signal::KILL }).unwrap();
        if stopped {
            // An actual stopped native child cannot answer a pipe operation.
            // Cancel only the operation; keep Context alive until checked close.
            assert!(
                tokio::time::timeout(Duration::from_millis(30), context.step(None, &mut NoKdc))
                    .await
                    .is_err()
            );
        } else {
            // No next operation is needed for the idle actor to observe a crash.
            let until = Instant::now() + Duration::from_secs(2);
            while Path::new(&format!("/proc/{id}")).exists() && Instant::now() < until {
                tokio::task::yield_now().await;
            }
            assert!(!Path::new(&format!("/proc/{id}")).exists());
            assert_eq!(
                context.step(None, &mut NoKdc).await.unwrap_err(),
                Error::Unavailable
            );
        }
        context.close().await.unwrap();
        assert!(!Path::new(&format!("/proc/{id}")).exists());
        let (replacement, _) = kerberos_worker::open(
            &path,
            credentials("fixture"),
            policy(),
            Instant::now() + Duration::from_secs(10),
            &mut NoKdc,
        )
        .await
        .unwrap();
        replacement.close().await.unwrap();
        assert_eq!(fs::read_dir(&path).unwrap().count(), 0);
    }
}

fn actual_children() -> Vec<u32> {
    let mut children = Vec::new();
    for task in fs::read_dir("/proc/self/task").unwrap() {
        if let Ok(text) = fs::read_to_string(task.unwrap().path().join("children")) {
            children.extend(text.split_whitespace().map(|id| id.parse::<u32>().unwrap()));
        }
    }
    children
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; strict matrix job"]
async fn cancellation_while_kdc_reply_is_pending_kills_waits_cleans_and_releases_real_slot() {
    use kerberos_worker::{KdcExchange, Password};
    use zeroize::Zeroizing;
    struct PendingKdc {
        observed: Option<tokio::sync::oneshot::Sender<()>>,
    }
    impl KdcExchange for PendingKdc {
        async fn authorize(&mut self) -> Result<(), Error> {
            Ok(())
        }
        async fn exchange(
            &mut self,
            realm: &str,
            request: &[u8],
        ) -> Result<Zeroizing<Vec<u8>>, Error> {
            assert_eq!(realm, "ISSUE37612.INVALID");
            assert!(!request.is_empty());
            self.observed.take().unwrap().send(()).unwrap();
            std::future::pending().await
        }
    }
    let root = root();
    let path = root.path().canonicalize().unwrap();
    let before = actual_children();
    let (sender, observed) = tokio::sync::oneshot::channel();
    let mut caller = PendingKdc {
        observed: Some(sender),
    };
    let source = Credentials::new(
        principal(&["probe"]),
        principal(&["vnc", "fixture"]),
        Source::Password(Password::new(Zeroizing::new("synthetic-cancel-only".into())).unwrap()),
    )
    .unwrap();
    let mut opening = Box::pin(kerberos_worker::open(
        &path,
        source,
        policy(),
        Instant::now() + Duration::from_secs(10),
        &mut caller,
    ));
    tokio::select! { result = &mut opening => panic!("unexpected premature result {result:?}"), result = observed => result.unwrap() }
    let ids = actual_children()
        .into_iter()
        .filter(|id| !before.contains(id))
        .collect::<Vec<_>>();
    assert_eq!(ids.len(), 1);
    drop(opening);
    let until = Instant::now() + Duration::from_secs(2);
    while ids
        .iter()
        .any(|id| std::path::Path::new(&format!("/proc/{id}")).exists())
        && Instant::now() < until
    {
        tokio::task::yield_now().await;
    }
    for id in ids {
        assert!(!std::path::Path::new(&format!("/proc/{id}")).exists());
    }
    let (replacement, _) = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        Instant::now() + Duration::from_secs(10),
        &mut NoKdc,
    )
    .await
    .unwrap();
    replacement.close().await.unwrap();
    assert_eq!(fs::read_dir(path).unwrap().count(), 0);
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; strict matrix job"]
async fn expensive_unauthenticated_preauth_is_cpu_bounded_and_reaped_before_new_admission() {
    use kerberos_worker::{KdcExchange, Password};
    use zeroize::Zeroizing;
    struct ExpensiveKdc {
        observed: Option<tokio::sync::oneshot::Sender<()>>,
        challenge: Zeroizing<Vec<u8>>,
        reply: Zeroizing<Vec<u8>>,
    }
    impl KdcExchange for ExpensiveKdc {
        async fn authorize(&mut self) -> Result<(), Error> {
            Ok(())
        }
        async fn exchange(&mut self, realm: &str, _: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
            assert_eq!(realm, "ISSUE37612.INVALID");
            let response = if let Some(observed) = self.observed.take() {
                observed.send(()).unwrap();
                &self.challenge
            } else {
                &self.reply
            };
            Ok(Zeroizing::new(response.to_vec()))
        }
    }
    let root = root();
    let path = root.path().canonicalize().unwrap();
    let before = actual_children();
    let (observed_tx, observed) = tokio::sync::oneshot::channel();
    // Maintained MIT encoded both PUBLIC NON-AUTHENTIC controls. AES256
    // preauth uses 0x00ffffff iterations, just below MIT's rejection limit.
    // If that one derivation completes under 12 CPU seconds, the admitted AES128
    // AS-REP forces MIT's password callback to derive again before rejecting its
    // bogus ciphertext. Repeating PREAUTH_REQUIRED would reuse the cached key
    // and refuse without exercising the CPU cap on faster native hosts.
    let decode = |value: &str| {
        Zeroizing::new(
            value
                .split_whitespace()
                .map(|byte| u8::from_str_radix(byte, 16).unwrap())
                .collect::<Vec<_>>(),
        )
    };
    let mut caller = ExpensiveKdc {
        observed: Some(observed_tx),
        challenge: decode(include_str!("fixtures/expensive-preauth-error.hex")),
        reply: decode(include_str!("fixtures/expensive-as-rep.hex")),
    };
    let source = Credentials::new(
        principal(&["probe"]),
        principal(&["vnc", "fixture"]),
        Source::Password(Password::new(Zeroizing::new("synthetic-cpu-only".into())).unwrap()),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut opening = Box::pin(kerberos_worker::open(
        &path,
        source,
        policy(),
        deadline,
        &mut caller,
    ));
    tokio::select! { result = &mut opening => panic!("unexpected premature result {result:?}"), result = observed => result.unwrap() }
    let ids = actual_children()
        .into_iter()
        .filter(|id| !before.contains(id))
        .collect::<Vec<_>>();
    assert_eq!(ids.len(), 1);
    let id = ids[0];
    let limits = fs::read_to_string(format!("/proc/{id}/limits")).unwrap();
    assert!(
        limits
            .lines()
            .any(|line| line.split_whitespace().collect::<Vec<_>>()
                == ["Max", "cpu", "time", "12", "12", "seconds"])
    );
    let ticks = std::process::Command::new("getconf")
        .arg("CLK_TCK")
        .output()
        .unwrap();
    assert!(ticks.status.success());
    let ticks = std::str::from_utf8(&ticks.stdout)
        .unwrap()
        .trim()
        .parse::<u64>()
        .unwrap();
    let mut max_cpu_ticks = 0;
    let mut sampling = tokio::time::interval(Duration::from_millis(20));
    let result = loop {
        tokio::select! {
            result = &mut opening => break result,
            _ = sampling.tick() => {
                if let Ok(stat) = fs::read_to_string(format!("/proc/{id}/stat")) {
                    let (_, fields) = stat.rsplit_once(") ").unwrap();
                    let cpu = fields.split_whitespace().nth(11).unwrap().parse::<u64>().unwrap();
                    max_cpu_ticks = max_cpu_ticks.max(cpu);
                }
            }
        }
    };
    drop(opening);
    let until = Instant::now() + Duration::from_secs(2);
    while Path::new(&format!("/proc/{id}")).exists() && Instant::now() < until {
        tokio::task::yield_now().await;
    }
    assert!(!Path::new(&format!("/proc/{id}")).exists());
    let (replacement, _) = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        Instant::now() + Duration::from_secs(10),
        &mut NoKdc,
    )
    .await
    .unwrap();
    replacement.close().await.unwrap();
    assert_eq!(fs::read_dir(path).unwrap().count(), 0);
    assert!(matches!(result, Err(Error::Unavailable)), "{result:?}");
    assert!(
        max_cpu_ticks >= 10 * ticks,
        "control did not actually consume the bounded CPU work: {max_cpu_ticks}/{ticks}"
    );
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; strict matrix job"]
async fn ready_kdc_callback_after_deadline_sends_nothing_and_reaps_before_new_admission() {
    use kerberos_worker::{KdcExchange, Password};
    use std::{
        io::{Read, Write},
        os::unix::net::UnixStream,
    };
    use zeroize::Zeroizing;
    struct GatedKdc {
        observed: Option<tokio::sync::oneshot::Sender<()>>,
        release: Option<tokio::sync::oneshot::Receiver<()>>,
        output: Option<UnixStream>,
    }
    impl KdcExchange for GatedKdc {
        async fn authorize(&mut self) -> Result<(), Error> {
            Ok(())
        }
        async fn exchange(
            &mut self,
            realm: &str,
            request: &[u8],
        ) -> Result<Zeroizing<Vec<u8>>, Error> {
            assert_eq!(realm, "ISSUE37612.INVALID");
            assert!(!request.is_empty());
            self.observed.take().unwrap().send(()).unwrap();
            self.release.take().unwrap().await.unwrap();
            // Public caller transport canary; no actual KDC or secret bytes.
            let mut output = self.output.take().unwrap();
            output.write_all(&[1]).unwrap();
            Err(Error::KdcUnavailable)
        }
    }
    let root = root();
    let path = root.path().canonicalize().unwrap();
    let before = actual_children();
    let (observed_tx, observed) = tokio::sync::oneshot::channel();
    let (released, release) = tokio::sync::oneshot::channel();
    let (output, mut peer) = UnixStream::pair().unwrap();
    let mut caller = GatedKdc {
        observed: Some(observed_tx),
        release: Some(release),
        output: Some(output),
    };
    let source = Credentials::new(
        principal(&["probe"]),
        principal(&["vnc", "fixture"]),
        Source::Password(Password::new(Zeroizing::new("synthetic-deadline-only".into())).unwrap()),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut opening = Box::pin(kerberos_worker::open(
        &path,
        source,
        policy(),
        deadline,
        &mut caller,
    ));
    tokio::select! { result = &mut opening => panic!("unexpected premature result {result:?}"), result = observed => result.unwrap() }
    let ids = actual_children()
        .into_iter()
        .filter(|id| !before.contains(id))
        .collect::<Vec<_>>();
    assert_eq!(ids.len(), 1);
    // Real process/clock boundary: do not pause Tokio around kernel/native IO.
    tokio::time::sleep_until(deadline).await;
    released.send(()).unwrap();
    let result = opening.as_mut().await;
    drop(opening);
    drop(caller);
    let until = Instant::now() + Duration::from_secs(2);
    while ids
        .iter()
        .any(|id| Path::new(&format!("/proc/{id}")).exists())
        && Instant::now() < until
    {
        tokio::task::yield_now().await;
    }
    for id in ids {
        assert!(!Path::new(&format!("/proc/{id}")).exists());
    }
    let (replacement, _) = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        Instant::now() + Duration::from_secs(10),
        &mut NoKdc,
    )
    .await
    .unwrap();
    replacement.close().await.unwrap();
    assert_eq!(fs::read_dir(path).unwrap().count(), 0);
    assert_eq!(
        peer.read(&mut [0]).unwrap(),
        0,
        "expired caller transport must not emit a byte before refusal"
    );
    assert!(matches!(result, Err(Error::Deadline)), "{result:?}");
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; strict matrix job"]
async fn ready_authority_after_ticket_expiry_sends_nothing_and_reaps_the_actual_process() {
    use kerberos_worker::KdcExchange;
    use std::{
        io::{Read, Write},
        os::unix::net::UnixStream,
    };
    use zeroize::Zeroizing;
    struct GatedAuthority {
        observed: Option<tokio::sync::oneshot::Sender<()>>,
        release: Option<tokio::sync::oneshot::Receiver<()>>,
        output: Option<UnixStream>,
    }
    impl KdcExchange for GatedAuthority {
        async fn authorize(&mut self) -> Result<(), Error> {
            self.observed.take().unwrap().send(()).unwrap();
            self.release.take().unwrap().await.unwrap();
            // Public authority IO canary, never a credential or GSS token.
            self.output.take().unwrap().write_all(&[1]).unwrap();
            Ok(())
        }
        async fn exchange(&mut self, _: &str, _: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
            panic!("offline import must not request KDC transport")
        }
    }
    let root = root();
    let path = root.path().canonicalize().unwrap();
    let now = common::now_seconds();
    let deadline = Instant::now() + Duration::from_secs(10);
    let (mut context, status) = kerberos_worker::open(
        &path,
        common::credentials_until(ticket("fixture"), now, now + 3),
        policy(),
        deadline,
        &mut NoKdc,
    )
    .await
    .unwrap();
    let id = context.process_id();
    let (observed_tx, observed) = tokio::sync::oneshot::channel();
    let (released, release) = tokio::sync::oneshot::channel();
    let (output, mut peer) = UnixStream::pair().unwrap();
    let mut caller = GatedAuthority {
        observed: Some(observed_tx),
        release: Some(release),
        output: Some(output),
    };
    let mut stepping = Box::pin(context.step(None, &mut caller));
    tokio::select! { result = &mut stepping => panic!("unexpected premature result {result:?}"), result = observed => result.unwrap() }
    // Use the actual public source expiry, not the longer operation deadline.
    tokio::time::sleep_until(status.expires_at).await;
    assert!(Instant::now() < deadline);
    released.send(()).unwrap();
    let result = stepping.as_mut().await;
    drop(stepping);
    drop(caller);
    context.close().await.unwrap();
    assert!(!Path::new(&format!("/proc/{id}")).exists());
    let (replacement, _) = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        Instant::now() + Duration::from_secs(10),
        &mut NoKdc,
    )
    .await
    .unwrap();
    replacement.close().await.unwrap();
    assert_eq!(fs::read_dir(path).unwrap().count(), 0);
    assert_eq!(
        peer.read(&mut [0]).unwrap(),
        0,
        "expired ticket authority must not resume IO before refusal"
    );
    assert!(matches!(result, Err(Error::Expired)), "{result:?}");
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; strict matrix job"]
async fn metadata_expiry_is_not_rounded_up_and_standard_long_lived_tickets_remain_admitted() {
    let root = root();
    let path = root.path().canonicalize().unwrap();
    let now = common::now_seconds();
    let end = now + 36000;
    let anchor = Instant::now();
    let expected = anchor
        + (UNIX_EPOCH + Duration::from_secs(u64::from(end)))
            .duration_since(SystemTime::now())
            .unwrap();
    let (mut context, status) = kerberos_worker::open(
        &path,
        common::credentials_until(ticket("fixture"), now, end),
        policy(),
        Instant::now() + Duration::from_secs(10),
        &mut NoKdc,
    )
    .await
    .unwrap();
    assert!(status.expires_at <= expected + Duration::from_millis(5));
    assert!(status.expires_at > Instant::now() + Duration::from_secs(7200));
    // Duration is ticket metadata, NOT a permission to extend the RFB two-hour cap.
    let step = context.step(None, &mut NoKdc).await.unwrap();
    assert!(!step.complete);
    drop(step);
    context.close().await.unwrap();
    assert_eq!(fs::read_dir(path).unwrap().count(), 0);
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; strict matrix job"]
async fn actual_idle_deadline_reaps_without_a_waiter_and_new_admission_is_available() {
    let root = root();
    let path = root.path().canonicalize().unwrap();
    let (context, _) = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        Instant::now() + Duration::from_millis(250),
        &mut NoKdc,
    )
    .await
    .unwrap();
    let id = context.process_id();
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert!(!std::path::Path::new(&format!("/proc/{id}")).exists());
    context.close().await.unwrap();
    let (replacement, _) = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        Instant::now() + Duration::from_secs(10),
        &mut NoKdc,
    )
    .await
    .unwrap();
    replacement.close().await.unwrap();
    assert_eq!(fs::read_dir(path).unwrap().count(), 0);
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; strict matrix job"]
async fn all_sixteen_queued_admissions_are_bounded_and_cancel_without_an_extra_process() {
    use std::{future::Future, task::Poll};
    let root = root();
    let path = root.path().canonicalize().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let (first, _) = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        deadline,
        &mut NoKdc,
    )
    .await
    .unwrap();
    let (second, _) = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        deadline,
        &mut NoKdc,
    )
    .await
    .unwrap();
    let ids = [first.process_id(), second.process_id()];
    let mut callers = (0..16).map(|_| NoKdc).collect::<Vec<_>>();
    let mut waiting = callers
        .iter_mut()
        .map(|caller| {
            Box::pin(kerberos_worker::open(
                &path,
                credentials("fixture"),
                policy(),
                deadline,
                caller,
            ))
        })
        .collect::<Vec<_>>();
    for future in &mut waiting {
        std::future::poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
    }
    let refused = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        deadline,
        &mut NoKdc,
    )
    .await;
    assert!(matches!(refused, Err(Error::Capacity)));
    drop(waiting);
    for id in ids {
        assert!(std::path::Path::new(&format!("/proc/{id}")).exists());
    }
    first.close().await.unwrap();
    second.close().await.unwrap();
    let (replacement, _) = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        deadline,
        &mut NoKdc,
    )
    .await
    .unwrap();
    replacement.close().await.unwrap();
    assert_eq!(fs::read_dir(path).unwrap().count(), 0);
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; strict matrix job"]
async fn empty_present_oversized_wrong_state_and_malformed_gss_tokens_are_terminal() {
    use zeroize::Zeroizing;
    let root = root();
    let path = root.path().canonicalize().unwrap();
    for input in [
        Some(Zeroizing::new(Vec::new())),
        Some(Zeroizing::new(vec![0; 16385])),
    ] {
        let (mut context, _) = kerberos_worker::open(
            &path,
            credentials("fixture"),
            policy(),
            Instant::now() + Duration::from_secs(10),
            &mut NoKdc,
        )
        .await
        .unwrap();
        let id = context.process_id();
        assert_eq!(
            context.step(input, &mut NoKdc).await.unwrap_err(),
            Error::Protocol
        );
        context.close().await.unwrap();
        assert!(!std::path::Path::new(&format!("/proc/{id}")).exists());
    }
    let (mut context, _) = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        Instant::now() + Duration::from_secs(10),
        &mut NoKdc,
    )
    .await
    .unwrap();
    drop(context.step(None, &mut NoKdc).await.unwrap());
    assert_eq!(
        context
            .step(Some(Zeroizing::new(b"not an AP-REP".to_vec())), &mut NoKdc)
            .await
            .unwrap_err(),
        Error::Protocol
    );
    context.close().await.unwrap();
    let (mut context, _) = kerberos_worker::open(
        &path,
        credentials("fixture"),
        policy(),
        Instant::now() + Duration::from_secs(10),
        &mut NoKdc,
    )
    .await
    .unwrap();
    assert_eq!(
        context
            .select_no_layer(Zeroizing::new(vec![1, 0, 0, 0]), &mut NoKdc)
            .await
            .unwrap_err(),
        Error::Protocol
    );
    context.close().await.unwrap();
    assert_eq!(fs::read_dir(path).unwrap().count(), 0);
}

#[test]
fn typed_password_policy_and_target_boundaries_are_redacted_and_finite() {
    use kerberos_worker::Password;
    use zeroize::Zeroizing;
    let password = Password::new(Zeroizing::new(" more than eight ".into())).unwrap();
    assert_eq!(format!("{password:?}"), "Password([REDACTED])");
    assert!(Password::new(Zeroizing::new("x".repeat(1024))).is_err());
    assert!(Password::new(Zeroizing::new("a\0b".into())).is_err());
    assert!(TicketPolicy::new(Duration::from_secs(7201), Duration::ZERO).is_err());
    assert!(TicketPolicy::new(Duration::ZERO, Duration::ZERO).is_err());
    assert!(
        Credentials::new(
            principal(&["probe"]),
            principal(&["qemu", "fixture"]),
            Source::Password(password)
        )
        .is_err()
    );
}
