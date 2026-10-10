use super::*;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use ureq::unversioned::transport::{LazyBuffers, time};

fn timeout() -> NextTimeout {
    NextTimeout {
        after: time::Duration::from_secs(7),
        reason: ureq::Timeout::Connect,
    }
}

#[derive(Debug)]
struct FailingResolver;

impl Resolver for FailingResolver {
    fn resolve(
        &self,
        _: &Uri,
        _: &Config,
        supplied: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        assert_eq!(supplied.after, timeout().after);
        assert_eq!(supplied.reason, timeout().reason);
        Err(ureq::Error::HostNotFound)
    }
}

#[derive(Clone, Copy, Debug)]
enum ConnectBehavior {
    Leaf,
    Recursive,
    Fail,
    Panic,
}

impl Connector for ConnectBehavior {
    type Out = Box<dyn Transport>;

    fn connect(
        &self,
        details: &ConnectionDetails,
        _: Option<()>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        assert_eq!(details.timeout.after, timeout().after);
        match self {
            Self::Leaf => Ok(Some(Box::new(TestTransport::new()))),
            Self::Recursive => {
                // Deliberately tolerate this synthetic lookup failure so the
                // test can exercise nested connector attribution in one call.
                let _ = details
                    .resolver
                    .resolve(details.uri, details.config, details.timeout);
                let mut transport = (details.run_connector)(details)?;
                // A CONNECT request before the outer wrapper exists must not
                // be mistaken for use of the target transport.
                transport.transmit_output(1, details.timeout)?;
                Ok(Some(transport))
            }
            Self::Fail => Err(ureq::Error::ConnectionFailed),
            Self::Panic => panic!("controlled connector unwind"),
        }
    }
}

fn connect(behavior: ConnectBehavior) -> Result<Option<Box<dyn Transport>>, ureq::Error> {
    connect_with_resolver(behavior, &ObservedResolver(FailingResolver))
}

fn connect_with_resolver(
    behavior: ConnectBehavior,
    resolver: &dyn Resolver,
) -> Result<Option<Box<dyn Transport>>, ureq::Error> {
    let uri = "http://example.invalid/archive".parse().unwrap();
    let config = Config::default();
    let details = ConnectionDetails {
        uri: &uri,
        addrs: resolver.empty(),
        config: &config,
        request_level: false,
        resolver,
        now: time::Instant::now(),
        timeout: timeout(),
        current_time: Arc::new(time::Instant::now),
        run_connector: Arc::new(|details| {
            ObservedConnector(ConnectBehavior::Leaf)
                .connect(details, None)
                .map(|transport| transport.expect("leaf supplies a transport"))
        }),
    };
    ObservedConnector(behavior).connect(&details, None)
}

#[derive(Debug, Default)]
struct TransportCalls {
    writes: Vec<(usize, time::Duration, ureq::Timeout)>,
    reads: usize,
    probes: usize,
}

#[derive(Debug)]
struct TestTransport {
    buffers: LazyBuffers,
    calls: Arc<Mutex<TransportCalls>>,
    fail_write: bool,
}

impl TestTransport {
    fn new() -> Self {
        Self {
            buffers: LazyBuffers::new(32, 32),
            calls: Arc::default(),
            fail_write: false,
        }
    }
}

impl Transport for TestTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }

    fn transmit_output(&mut self, amount: usize, supplied: NextTimeout) -> Result<(), ureq::Error> {
        self.calls
            .lock()
            .unwrap()
            .writes
            .push((amount, supplied.after, supplied.reason));
        if self.fail_write {
            Err(ureq::Error::ConnectionFailed)
        } else {
            Ok(())
        }
    }

    fn await_input(&mut self, supplied: NextTimeout) -> Result<bool, ureq::Error> {
        assert_eq!(supplied.after, timeout().after);
        assert_eq!(supplied.reason, timeout().reason);
        self.calls.lock().unwrap().reads += 1;
        Ok(false)
    }

    fn is_open(&mut self) -> bool {
        self.calls.lock().unwrap().probes += 1;
        true
    }

    fn is_tls(&self) -> bool {
        true
    }
}

fn summary(state: &SharedState) -> Summary {
    state
        .borrow()
        .summary(Duration::ZERO, CallOutcome::ResponseHeaders)
}

#[test]
fn resolver_and_recursive_connector_observe_entered_boundaries_once() {
    let call = CallObservation::start();
    let state = active().unwrap();
    let resolver = ObservedResolver(FailingResolver);
    assert!(matches!(
        resolver.resolve(
            &"http://example.invalid/".parse().unwrap(),
            &Config::default(),
            timeout(),
        ),
        Err(ureq::Error::HostNotFound)
    ));
    let failed = summary(&state);
    assert_eq!(failed.resolve_outside_setup.status, PhaseStatus::Failed);
    assert_eq!(failed.resolve_outside_setup.errors, 1);
    assert!(failed.resolve_outside_setup.duration_us.is_some());
    assert_eq!(failed.connection_setup.status, PhaseStatus::NotEntered);
    assert_eq!(failed.connection_setup.duration_us, None);
    let mut transport = connect(ConnectBehavior::Recursive).unwrap().unwrap();
    let nested = summary(&state);
    assert_eq!(nested.connection_setup.invocations, 1);
    assert_eq!(nested.connection_setup.completed, 1);
    assert_eq!(nested.resolve_inside_setup.invocations, 1);
    assert_eq!(nested.resolve_inside_setup.errors, 1);
    assert_eq!(nested.transport_use, TransportUse::Unobserved);
    assert!(
        state.borrow().connection_setup.duration >= state.borrow().resolve_inside_setup.duration
    );
    transport.transmit_output(1, timeout()).unwrap();
    assert_eq!(summary(&state).transport_use, TransportUse::NewForCallOnly);
    call.finish(Duration::ZERO, true);
}

#[test]
fn connector_failure_and_unwind_restore_the_enclosing_scope() {
    let outer = CallObservation::start();
    let outer_state = active().unwrap();
    assert!(matches!(
        connect(ConnectBehavior::Fail),
        Err(ureq::Error::ConnectionFailed)
    ));
    assert_eq!(summary(&outer_state).connection_setup.errors, 1);
    let inner_state;
    {
        let inner = CallObservation::start();
        inner_state = active().unwrap();
        let result = catch_unwind(AssertUnwindSafe(move || {
            let _inner = inner;
            let _ = connect(ConnectBehavior::Panic);
        }));
        assert!(result.is_err());
    }
    assert!(Rc::ptr_eq(&active().unwrap(), &outer_state));
    assert_eq!(inner_state.borrow().connector_depth, 0);
    assert_eq!(summary(&inner_state).connection_setup.interrupted, 1);
    assert_eq!(
        summary(&inner_state).connection_setup.status,
        PhaseStatus::Interrupted
    );
    connect(ConnectBehavior::Leaf).unwrap();
    assert_eq!(summary(&outer_state).connection_setup.invocations, 2);
    assert_eq!(
        summary(&outer_state).connection_setup.status,
        PhaseStatus::Mixed
    );
    outer.finish(Duration::ZERO, false);
    assert!(active().is_none());
}

#[test]
fn transport_preserves_results_and_ignores_probes_and_buffered_input() {
    let call = CallObservation::start();
    let state = active().unwrap();
    let mut inner = TestTransport::new();
    inner.buffers.input_append_buf()[..2].copy_from_slice(b"ab");
    inner.buffers.input_appended(2);
    inner.buffers.input_consume(1);
    let calls = Arc::clone(&inner.calls);
    let mut transport = ObservedTransport {
        inner: Box::new(inner),
        creating_call: state.borrow().call_id,
    };
    assert!(transport.is_open());
    assert!(transport.is_tls());
    assert_eq!(transport.buffers().input(), b"b");
    assert!(transport.maybe_await_input(timeout()).unwrap());
    transport.transmit_output(0, timeout()).unwrap();
    assert_eq!(summary(&state).transport_use, TransportUse::Unobserved);
    assert_eq!(calls.lock().unwrap().reads, 0);
    assert_eq!(calls.lock().unwrap().probes, 1);
    assert!(!transport.await_input(timeout()).unwrap());
    transport.transmit_output(3, timeout()).unwrap();
    let recorded = calls.lock().unwrap();
    assert_eq!(recorded.reads, 1);
    assert_eq!(recorded.writes.len(), 2);
    assert_eq!(recorded.writes[1].0, 3);
    assert_eq!(recorded.writes[1].1, timeout().after);
    assert_eq!(recorded.writes[1].2, timeout().reason);
    drop(recorded);
    assert_eq!(summary(&state).transport_use, TransportUse::NewForCallOnly);
    call.finish(Duration::ZERO, true);
}

#[test]
fn retained_transport_observes_current_call_and_body_cannot_mutate_finished_call() {
    let first = CallObservation::start();
    let first_state = active().unwrap();
    let mut retained = connect(ConnectBehavior::Leaf).unwrap().unwrap();
    first.finish(Duration::ZERO, true);
    // Simulate response-body transport access after the header scope has ended.
    retained.await_input(timeout()).unwrap();
    assert_eq!(
        summary(&first_state).transport_use,
        TransportUse::Unobserved
    );

    thread::spawn(move || {
        assert!(active().is_none());
        let second = CallObservation::start();
        let second_state = active().unwrap();
        retained.transmit_output(1, timeout()).unwrap();
        assert_eq!(
            summary(&second_state).transport_use,
            TransportUse::PriorCallOnly
        );
        let mut fresh = connect(ConnectBehavior::Leaf).unwrap().unwrap();
        fresh.await_input(timeout()).unwrap();
        assert_eq!(summary(&second_state).transport_use, TransportUse::Mixed);
        second.finish(Duration::ZERO, true);
        assert!(active().is_none());
    })
    .join()
    .unwrap();
    assert_eq!(
        summary(&first_state).transport_use,
        TransportUse::Unobserved
    );
    assert!(active().is_none());
}

#[derive(Debug)]
struct GatedResolver {
    entered: mpsc::Sender<Instant>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl Resolver for GatedResolver {
    fn resolve(
        &self,
        _: &Uri,
        _: &Config,
        _: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        self.entered.send(Instant::now()).unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .expect("test releases resolver at the observed dependency boundary");
        Err(ureq::Error::HostNotFound)
    }
}

#[test]
fn phase_durations_enclose_gated_resolution_outside_and_inside_setup() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        let call = CallObservation::start();
        let state = active().unwrap();
        let resolver = ObservedResolver(GatedResolver {
            entered: entered_tx,
            release: Mutex::new(release_rx),
        });
        let _ = resolver.resolve(
            &"http://example.invalid/".parse().unwrap(),
            &Config::default(),
            timeout(),
        );
        connect_with_resolver(ConnectBehavior::Recursive, &resolver).unwrap();
        let observed = {
            let state = state.borrow();
            assert_eq!(state.resolve_outside_setup.invocations, 1);
            assert_eq!(state.resolve_inside_setup.invocations, 1);
            assert_eq!(state.connection_setup.invocations, 1);
            (
                state.resolve_outside_setup.duration,
                state.resolve_inside_setup.duration,
                state.connection_setup.duration,
            )
        };
        call.finish(Duration::ZERO, true);
        observed
    });
    // Witness intervals while each delegate is held at its actual boundary;
    // there is no sleep or scheduling-duration threshold.
    let outside_entered = entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(
        active().is_none(),
        "worker scope must not leak to this thread"
    );
    let outside_held = outside_entered.elapsed();
    release_tx.send(()).unwrap();
    let inside_entered = entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let inside_held = inside_entered.elapsed();
    release_tx.send(()).unwrap();
    let (outside, inside, setup) = worker.join().unwrap();
    assert!(outside >= outside_held);
    assert!(inside >= inside_held);
    assert!(setup >= inside);
}

#[test]
fn failed_write_is_attempted_use_and_exhausted_identity_never_matches() {
    let counter = AtomicU64::new(u64::MAX - 1);
    assert_eq!(allocate_call_id(&counter), Some(u64::MAX - 1));
    assert_eq!(allocate_call_id(&counter), None);
    assert_eq!(allocate_call_id(&counter), None);

    let call = CallObservation::start();
    let state = active().unwrap();
    let mut inner = TestTransport::new();
    inner.fail_write = true;
    let mut transport = ObservedTransport {
        inner: Box::new(inner),
        creating_call: state.borrow().call_id,
    };
    assert!(matches!(
        transport.transmit_output(1, timeout()),
        Err(ureq::Error::ConnectionFailed)
    ));
    assert_eq!(summary(&state).transport_use, TransportUse::NewForCallOnly);
    state.borrow_mut().call_id = None;
    transport.creating_call = None;
    let _ = transport.transmit_output(1, timeout());
    assert_eq!(summary(&state).transport_use, TransportUse::Unavailable);
    call.finish(Duration::ZERO, false);
}

#[test]
fn serialized_record_has_a_fixed_budget_even_at_counter_saturation() {
    let maximal_phase = || Phase {
        invocations: u64::MAX,
        completed: u64::MAX,
        errors: u64::MAX,
        interrupted: u64::MAX,
        duration: Duration::MAX,
    };
    let state = ObservationState {
        resolve_outside_setup: maximal_phase(),
        resolve_inside_setup: maximal_phase(),
        connection_setup: maximal_phase(),
        used_new: true,
        ..ObservationState::default()
    };
    let json =
        serde_json::to_string(&state.summary(Duration::MAX, CallOutcome::ResponseHeaders)).unwrap();
    assert!(json.len() + "remote_connection_observation ".len() <= 1024);
    let unentered = serde_json::to_value(Phase::default().summary()).unwrap();
    assert!(unentered.get("duration_us").is_none());
}
