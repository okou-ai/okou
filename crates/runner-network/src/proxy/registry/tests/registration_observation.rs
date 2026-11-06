use super::*;

#[derive(Default)]
pub(super) struct RegistrationObservations {
    pub(super) stages: Vec<(ProxyRegistrationStage, Duration, bool)>,
    sizes: Vec<(usize, usize)>,
}

impl ProxyRegistrationObserver for RegistrationObservations {
    fn record_stage(&mut self, stage: ProxyRegistrationStage, elapsed: Duration, success: bool) {
        self.stages.push((stage, elapsed, success));
    }

    fn registry_size(&mut self, bytes: usize, entries: usize) {
        self.sizes.push((bytes, entries));
    }
}

#[tokio::test]
async fn registration_observes_required_boundaries_and_published_size() {
    use ProxyRegistrationStage::*;
    let harness = RegistryHarness::new().await;
    let mut observations = RegistrationObservations::default();
    let publication = harness
        .handle
        .register_sandbox_with_observer("10.200.0.2", &base_registration(), &mut observations)
        .await
        .unwrap();
    assert_eq!(
        observations
            .stages
            .iter()
            .map(|&(stage, _, success)| (stage, success))
            .collect::<Vec<_>>(),
        vec![
            (Prepare, true),
            (Lock, true),
            (Read, true),
            (Parse, true),
            (Mutate, true),
            (Capacity, true),
            (Serialize, true),
            (Digest, true),
            (PublishQueue, true),
            (PublishWrite, true),
            (Publish, true)
        ]
    );
    let stored = std::fs::read(harness.registry_path()).unwrap();
    assert_eq!(publication.digest, RegistryDigest::of(&stored));
    assert_eq!(observations.sizes, vec![(stored.len(), 1)]);
    let duration = |stage| {
        observations
            .stages
            .iter()
            .find(|entry| entry.0 == stage)
            .unwrap()
            .1
    };
    assert!(duration(PublishQueue) + duration(PublishWrite) <= duration(Publish));
}

#[tokio::test]
async fn registration_read_and_parse_failures_stop_before_mutation() {
    use ProxyRegistrationStage::*;
    for invalid_json in [false, true] {
        let harness = RegistryHarness::new().await;
        if invalid_json {
            std::fs::write(harness.registry_path(), "invalid registry").unwrap();
        } else {
            std::fs::remove_file(harness.registry_path()).unwrap();
        }
        let mut observations = RegistrationObservations::default();
        let error = harness
            .handle
            .register_sandbox_with_observer("10.200.0.2", &base_registration(), &mut observations)
            .await
            .unwrap_err();
        let expected = if invalid_json {
            assert!(error.to_string().contains("parse registry"));
            vec![(Prepare, true), (Lock, true), (Read, true), (Parse, false)]
        } else {
            assert!(error.to_string().contains("not found"));
            vec![(Prepare, true), (Lock, true), (Read, false)]
        };
        assert_eq!(
            observations
                .stages
                .iter()
                .map(|&(stage, _, success)| (stage, success))
                .collect::<Vec<_>>(),
            expected
        );
        assert!(observations.sizes.is_empty());
        assert!(matches!(
            lock::try_acquire_or_busy_blocking(&harness.handle.lock_path).unwrap(),
            lock::TryLock::Acquired(_)
        ));
    }
}
