//! Opt-in physical lifecycle proof against one independently owned Firecracker.
//!
//! The caller boots a disposable 4-GiB VM with balloon statistics enabled and
//! supplies its API socket and PID. This test neither starts nor destroys VMs;
//! the external harness must bound and clean up its VM even if the test fails.

use super::*;
use crate::api::ApiError;
use std::error::Error;
use std::path::{Path, PathBuf};

type NativeResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

const MEMORY_MIB: u32 = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scenario {
    Normal,
    BeforeInflate,
    DuringInflate,
    DuringDeflate,
}

impl Scenario {
    fn from_environment() -> NativeResult<Self> {
        match std::env::var("OKOU_TEST_PARK_SCENARIO")?.as_str() {
            "normal" => Ok(Self::Normal),
            "before_inflate" => Ok(Self::BeforeInflate),
            "during_inflate" => Ok(Self::DuringInflate),
            "during_deflate" => Ok(Self::DuringDeflate),
            other => Err(io::Error::other(format!("unknown native park scenario: {other}")).into()),
        }
    }
}

struct NativeObserver {
    pid: u32,
    settled_rss_kib: Option<u64>,
}

impl SandboxFinalExecParkObserver for NativeObserver {
    fn record_stage(
        &mut self,
        _stage: SandboxFinalExecParkStage,
        _duration: Duration,
        _success: bool,
    ) {
    }

    fn record_substage(
        &mut self,
        substage: SandboxFinalExecParkSubstage,
        duration: Duration,
        success: bool,
        outcome: Option<SandboxFinalExecParkSubstageOutcome>,
    ) {
        let rss = rss_kib(self.pid).expect("owned Firecracker process must remain observable");
        if substage == SandboxFinalExecParkSubstage::BalloonSettle {
            self.settled_rss_kib = Some(rss);
        }
        println!(
            "NATIVE_PARK_SUBSTAGE stage={substage:?} elapsed_us={} success={success} outcome={outcome:?} rss_kib={rss}",
            duration.as_micros(),
        );
    }
}

fn rss_kib(pid: u32) -> NativeResult<u64> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status"))?;
    status
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:")?.split_whitespace().next())
        .ok_or_else(|| io::Error::other("Firecracker VmRSS absent"))?
        .parse()
        .map_err(Into::into)
}

async fn vm_state(socket: &Path) -> NativeResult<String> {
    let body: serde_json::Value = reqwest::Client::builder()
        .unix_socket(socket.to_owned())
        .timeout(Duration::from_secs(3))
        .build()?
        .get("http://localhost/")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    body.get("state")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| io::Error::other("Firecracker state absent").into())
}

async fn request_during_phase(
    socket: &Path,
    scenario: Scenario,
    handoff: &SandboxFinalExecParkHandoff,
) -> NativeResult<()> {
    if matches!(scenario, Scenario::Normal | Scenario::BeforeInflate) {
        return Ok(());
    }
    let client = ApiClient::new(socket)?;
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let stats = client.get_balloon_statistics().await?;
            let selected = match scenario {
                Scenario::DuringInflate => {
                    stats.target_pages > 0
                        && stats.actual_pages > 0
                        && stats.actual_pages < stats.target_pages
                }
                Scenario::DuringDeflate => stats.target_pages == 0 && stats.actual_pages > 0,
                Scenario::Normal | Scenario::BeforeInflate => false,
            };
            if selected {
                assert!(handoff.request(), "native request must have one successor");
                println!(
                    "NATIVE_PARK_REQUEST scenario={scenario:?} target_pages={} actual_pages={}",
                    stats.target_pages, stats.actual_pages,
                );
                return Ok::<_, ApiError>(());
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await??;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an independently owned, running 4-GiB Firecracker VM and its API socket/PID"]
async fn physical_park_reclaims_before_pause_and_hands_off_without_pause() -> NativeResult<()> {
    let socket = PathBuf::from(std::env::var("OKOU_TEST_PARK_API_SOCKET")?);
    let pid: u32 = std::env::var("OKOU_TEST_PARK_FIRECRACKER_PID")?.parse()?;
    let scenario = Scenario::from_environment()?;
    let client = ApiClient::new(&socket)?;
    assert_eq!(vm_state(&socket).await?, "Running");
    let stats = client.get_balloon_statistics().await?;
    assert_eq!((stats.target_pages, stats.actual_pages), (0, 0));
    let rss_before = rss_kib(pid)?;
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
    let handoff = SandboxFinalExecParkHandoff::new();
    if scenario == Scenario::BeforeInflate {
        assert!(handoff.request());
    }
    let mut is_parked = false;
    let mut observer = NativeObserver {
        pid,
        settled_rss_kib: None,
    };
    let started = Instant::now();
    let result = {
        let park = park_inner_with_guest_and_handoff(
            &mut is_parked,
            MEMORY_MIB,
            &socket,
            "native-park",
            PhysicalParkRequest {
                guest: Arc::new(tokio::sync::Mutex::new(None)),
                state_rx: state_rx.clone(),
                handoff: (scenario != Scenario::Normal).then_some(&handoff),
                memory_policy: ParkMemoryPolicy::Reclaim,
            },
            SandboxFinalExecParkSubstageEvents::new(Some(&mut observer)),
        );
        let request = request_during_phase(&socket, scenario, &handoff);
        let ((_events, result), requested) = tokio::join!(park, request);
        requested?;
        result?
    };
    let park_elapsed = started.elapsed();
    let state = vm_state(&socket).await?;
    let stats = client.get_balloon_statistics().await?;
    let rss_after = rss_kib(pid)?;
    assert_eq!(stats.target_pages, 0);
    if scenario == Scenario::Normal {
        assert!(matches!(
            result,
            PhysicalParkOutcome::Idle(SandboxParkOutcome::Reusable)
        ));
        assert!(is_parked);
        assert_eq!(state, "Paused");
        assert_eq!(stats.actual_pages, 0);
        let settled_rss = observer
            .settled_rss_kib
            .expect("normal park records reclamation");
        // Allow bounded kernel/allocator metadata activity between reclamation
        // and pause, but reject eager repopulation of the reclaimed GiB range.
        assert!(rss_after <= settled_rss + 128 * 1024);
    } else {
        let expected = match scenario {
            Scenario::BeforeInflate => SandboxFinalExecParkHandoffPoint::BeforeBalloon,
            Scenario::DuringInflate => SandboxFinalExecParkHandoffPoint::DuringBalloonSettle,
            Scenario::DuringDeflate => SandboxFinalExecParkHandoffPoint::DuringDeflation,
            Scenario::Normal => return Err(io::Error::other("expected a handoff scenario").into()),
        };
        assert!(matches!(result, PhysicalParkOutcome::Handoff(point) if point == expected));
        assert!(!is_parked);
        assert_eq!(state, "Running");
    }
    println!(
        "NATIVE_PARK_BOUNDARY scenario={scenario:?} elapsed_us={} state={state} target_pages={} actual_pages={} rss_before_kib={rss_before} rss_after_kib={rss_after}",
        park_elapsed.as_micros(),
        stats.target_pages,
        stats.actual_pages,
    );

    let reuse_started = Instant::now();
    unpark_inner(
        &mut is_parked,
        MEMORY_MIB,
        match &result {
            PhysicalParkOutcome::Idle(outcome) => Some(outcome),
            PhysicalParkOutcome::Handoff(_) => None,
        },
        &socket,
        state_rx,
        "native-reuse",
    )
    .await?;
    assert!(!is_parked);
    assert_eq!(vm_state(&socket).await?, "Running");
    let stats = client.get_balloon_statistics().await?;
    assert_eq!((stats.target_pages, stats.actual_pages), (0, 0));
    println!(
        "NATIVE_PARK_PASS scenario={scenario:?} reuse_us={} rss_kib={}",
        reuse_started.elapsed().as_micros(),
        rss_kib(pid)?,
    );
    Ok(())
}
