use std::collections::VecDeque;
use std::path::PathBuf;

use super::*;

#[derive(Default)]
struct FakeSystemdOps {
    active: bool,
    enable_error: bool,
    restore_enablement_error: bool,
    reload_errors: VecDeque<bool>,
    commands: Vec<Vec<String>>,
    restored_enablement: Vec<SystemdUnitEnablement>,
    reload_requirements: Vec<SystemdReloadRequirement>,
}

impl ServiceInstallOps for FakeSystemdOps {
    fn is_active<'a>(&'a mut self, _unit: &'a RunnerServiceUnit) -> ServiceFuture<'a, bool> {
        let active = self.active;
        Box::pin(async move { Ok(active) })
    }

    fn systemctl<'a>(&'a mut self, args: &'a [&'a str]) -> ServiceFuture<'a, ()> {
        self.commands
            .push(args.iter().map(|arg| (*arg).to_owned()).collect());
        let fail = self.enable_error && args.first() == Some(&"enable");
        Box::pin(async move {
            if fail {
                Err(RunnerError::Internal("enable failed".to_owned()))
            } else {
                Ok(())
            }
        })
    }

    fn restore_enablement<'a>(
        &'a mut self,
        _unit: &'a RunnerServiceUnit,
        enablement: SystemdUnitEnablement,
    ) -> ServiceFuture<'a, ()> {
        self.restored_enablement.push(enablement);
        let fail = self.restore_enablement_error;
        Box::pin(async move {
            if fail {
                Err(RunnerError::Internal(
                    "restore enablement failed".to_owned(),
                ))
            } else {
                Ok(())
            }
        })
    }

    fn reload<'a>(
        &'a mut self,
        _unit: &'a RunnerServiceUnit,
        requirement: SystemdReloadRequirement,
    ) -> ServiceFuture<'a, ()> {
        self.reload_requirements.push(requirement);
        let fail = self.reload_errors.pop_front().unwrap_or(false);
        Box::pin(async move {
            if fail {
                Err(RunnerError::Internal("reload failed".to_owned()))
            } else {
                Ok(())
            }
        })
    }
}

#[derive(Clone, Copy, Debug)]
enum InitialOverride {
    Absent,
    EmptyDirectory,
    Present,
}

struct InstallFixture {
    _dir: tempfile::TempDir,
    unit: RunnerServiceUnit,
    unit_path: PathBuf,
    systemd_root: PathBuf,
    drop_in_dir: PathBuf,
    override_path: PathBuf,
    unit_content: String,
}

impl InstallFixture {
    fn new(initial: InitialOverride) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let unit = RunnerServiceUnit::from_suffix("test").unwrap();
        let unit_path = dir.path().join(unit.service_name());
        let systemd_root = dir.path().join("runtime-systemd");
        let drop_in_dir = systemd_root.join(format!("{}.d", unit.service_name()));
        let override_path = drop_in_dir.join("50-vm0-drain.conf");
        match initial {
            InitialOverride::Absent => {}
            InitialOverride::EmptyDirectory => std::fs::create_dir_all(&drop_in_dir).unwrap(),
            InitialOverride::Present => {
                write_drain_restart_override_at(&systemd_root, &unit).unwrap();
                std::fs::write(
                    drop_in_dir.join("90-operator.conf"),
                    "[Service]\nEnvironment=EXTRA=1\n",
                )
                .unwrap();
            }
        }
        let unit_content = generate_unit_file(
            &unit,
            Path::new("/usr/local/bin/runner"),
            Path::new("/config/activation.yaml"),
            &[],
            false,
        );
        Self {
            _dir: dir,
            unit,
            unit_path,
            systemd_root,
            drop_in_dir,
            override_path,
            unit_content,
        }
    }

    async fn activate(
        &self,
        prior_enablement: SystemdUnitEnablement,
        ops: &mut FakeSystemdOps,
    ) -> RunnerResult<()> {
        activate_with_ops(
            &self.unit,
            &self.unit_path,
            &self.systemd_root,
            &self.unit_content,
            prior_enablement,
            ops,
        )
        .await
    }

    fn assert_unit_written(&self) {
        assert_eq!(
            std::fs::read_to_string(&self.unit_path).unwrap(),
            self.unit_content
        );
    }

    fn assert_operator_drop_in_preserved(&self) {
        assert_eq!(
            std::fs::read_to_string(self.drop_in_dir.join("90-operator.conf")).unwrap(),
            "[Service]\nEnvironment=EXTRA=1\n"
        );
    }
}

#[tokio::test]
async fn reload_failure_preserves_filesystem_override_ownership() {
    for initial in [
        InitialOverride::EmptyDirectory,
        InitialOverride::Absent,
        InitialOverride::Present,
    ] {
        for prior_enablement in [
            SystemdUnitEnablement::Enabled,
            SystemdUnitEnablement::EnabledRuntime,
            SystemdUnitEnablement::NotEnabled,
        ] {
            let fixture = InstallFixture::new(initial);
            let mut ops = FakeSystemdOps {
                reload_errors: VecDeque::from([true, false]),
                ..FakeSystemdOps::default()
            };

            let error = fixture
                .activate(prior_enablement, &mut ops)
                .await
                .unwrap_err();

            assert!(
                error.to_string().contains("reload failed"),
                "{initial:?}: {error}"
            );
            fixture.assert_unit_written();
            let mut forward_requirement = SystemdReloadRequirement::dirty_or_not_found();
            let mut rollback_requirement = SystemdReloadRequirement::dirty_or_not_found();
            match initial {
                InitialOverride::Present => {
                    assert_eq!(
                        std::fs::read_to_string(&fixture.override_path).unwrap(),
                        "[Service]\nRestart=no\n"
                    );
                    fixture.assert_operator_drop_in_preserved();
                    forward_requirement = forward_requirement.with_drain_override(false);
                    rollback_requirement = rollback_requirement.with_drain_override(true);
                }
                InitialOverride::EmptyDirectory => {
                    assert!(
                        !fixture.override_path.exists(),
                        "directory-only cleanup recreated the override"
                    );
                    assert!(!fixture.drop_in_dir.exists());
                    forward_requirement = forward_requirement.with_drain_override(false);
                }
                InitialOverride::Absent => {
                    assert!(
                        !fixture.override_path.exists(),
                        "absent paths acquired an override"
                    );
                    assert!(!fixture.drop_in_dir.exists());
                }
            }
            assert_eq!(ops.restored_enablement, [prior_enablement]);
            assert_eq!(
                ops.reload_requirements,
                [forward_requirement, rollback_requirement]
            );
            assert_eq!(
                ops.commands,
                [vec!["enable", "--no-reload", fixture.unit.service_name()]]
            );
        }
    }
}

#[tokio::test]
async fn successful_cleanup_installs_and_starts_without_restoring_override() {
    for initial in [
        InitialOverride::EmptyDirectory,
        InitialOverride::Absent,
        InitialOverride::Present,
    ] {
        let fixture = InstallFixture::new(initial);
        let mut ops = FakeSystemdOps::default();

        fixture
            .activate(SystemdUnitEnablement::NotEnabled, &mut ops)
            .await
            .unwrap();

        fixture.assert_unit_written();
        assert!(!fixture.override_path.exists());
        match initial {
            InitialOverride::Present => fixture.assert_operator_drop_in_preserved(),
            InitialOverride::EmptyDirectory | InitialOverride::Absent => {
                assert!(!fixture.drop_in_dir.exists())
            }
        }
        let requirement = match initial {
            InitialOverride::Absent => SystemdReloadRequirement::dirty_or_not_found(),
            InitialOverride::EmptyDirectory | InitialOverride::Present => {
                SystemdReloadRequirement::dirty_or_not_found().with_drain_override(false)
            }
        };
        assert_eq!(ops.reload_requirements, [requirement]);
        assert!(ops.restored_enablement.is_empty());
        assert_eq!(
            ops.commands,
            [
                vec!["enable", "--no-reload", fixture.unit.service_name()],
                vec!["start", fixture.unit.service_name()]
            ]
        );
    }
}

#[tokio::test]
async fn active_install_preserves_override_during_success_and_reload_failure() {
    for reload_fails in [false, true] {
        let fixture = InstallFixture::new(InitialOverride::Present);
        let original = "[Service]\nRestart=no\n# preserve original contents\n";
        std::fs::write(&fixture.override_path, original).unwrap();
        let mut ops = FakeSystemdOps {
            active: true,
            reload_errors: VecDeque::from([reload_fails, false]),
            ..FakeSystemdOps::default()
        };

        let result = fixture
            .activate(SystemdUnitEnablement::EnabledRuntime, &mut ops)
            .await;

        assert_eq!(result.is_err(), reload_fails);
        fixture.assert_unit_written();
        assert_eq!(
            std::fs::read_to_string(&fixture.override_path).unwrap(),
            original
        );
        fixture.assert_operator_drop_in_preserved();
        assert_eq!(
            ops.reload_requirements,
            vec![SystemdReloadRequirement::dirty_or_not_found(); if reload_fails { 2 } else { 1 }]
        );
        if reload_fails {
            assert_eq!(
                ops.restored_enablement,
                [SystemdUnitEnablement::EnabledRuntime]
            );
            assert_eq!(
                ops.commands,
                [vec!["enable", "--no-reload", fixture.unit.service_name()]]
            );
        } else {
            assert!(ops.restored_enablement.is_empty());
            assert_eq!(
                ops.commands,
                [
                    vec!["enable", "--no-reload", fixture.unit.service_name()],
                    vec!["start", fixture.unit.service_name()]
                ]
            );
        }
    }
}

#[tokio::test]
async fn combined_failures_restore_owned_override_and_retain_all_errors() {
    let fixture = InstallFixture::new(InitialOverride::Present);
    let mut ops = FakeSystemdOps {
        enable_error: true,
        restore_enablement_error: true,
        reload_errors: VecDeque::from([true, true]),
        ..FakeSystemdOps::default()
    };

    let error = fixture
        .activate(SystemdUnitEnablement::EnabledRuntime, &mut ops)
        .await
        .unwrap_err();

    let message = error.to_string();
    assert!(message.contains("enable failed"));
    assert!(
        message.contains("additionally failed to reload systemd: internal error: reload failed"),
        "{message}"
    );
    assert!(
        message.contains("restore boot enablement: internal error: restore enablement failed"),
        "{message}"
    );
    assert!(
        message.contains("reload restored systemd state: internal error: reload failed"),
        "{message}"
    );
    assert_eq!(
        std::fs::read_to_string(&fixture.override_path).unwrap(),
        "[Service]\nRestart=no\n"
    );
    fixture.assert_operator_drop_in_preserved();
    assert_eq!(
        ops.restored_enablement,
        [SystemdUnitEnablement::EnabledRuntime]
    );
    assert_eq!(
        ops.commands,
        [vec!["enable", "--no-reload", fixture.unit.service_name()]]
    );
}

#[tokio::test]
async fn enable_failure_still_reloads_and_does_not_start_service() {
    let fixture = InstallFixture::new(InitialOverride::Present);
    let mut ops = FakeSystemdOps {
        enable_error: true,
        ..FakeSystemdOps::default()
    };

    let error = fixture
        .activate(SystemdUnitEnablement::NotEnabled, &mut ops)
        .await
        .unwrap_err();

    assert!(error.to_string().contains("enable failed"));
    fixture.assert_unit_written();
    assert!(!fixture.override_path.exists());
    fixture.assert_operator_drop_in_preserved();
    assert_eq!(
        ops.reload_requirements,
        [SystemdReloadRequirement::dirty_or_not_found().with_drain_override(false)]
    );
    assert!(ops.restored_enablement.is_empty());
    assert_eq!(
        ops.commands,
        [vec!["enable", "--no-reload", fixture.unit.service_name()]]
    );
}
