use super::*;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::symlink;

fn set_delegate_xattr(path: &Path) {
    let path = CString::new(path.as_os_str().as_bytes()).unwrap();
    // SAFETY: pointers and lengths refer to valid process memory.
    let result = unsafe {
        libc::setxattr(
            path.as_ptr(),
            DELEGATE_XATTR.as_ptr().cast(),
            b"1".as_ptr().cast(),
            1,
            0,
        )
    };
    assert_eq!(result, 0, "setxattr: {}", io::Error::last_os_error());
}

fn fake_delegated_tree() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let mount = temp.path().join("cgroup");
    let root = mount.join("system.slice/vm0-runner.service");
    let control = root.join(CONTROL_GROUP);
    let guests = root.join(GUESTS_GROUP);
    fs::create_dir_all(&control).unwrap();
    fs::create_dir(&guests).unwrap();
    set_delegate_xattr(&root);
    fs::write(root.join(CGROUP_CONTROLLERS), "cpu memory\n").unwrap();
    fs::write(root.join(CGROUP_SUBTREE_CONTROL), "").unwrap();
    fs::write(root.join(CGROUP_PROCS), "").unwrap();
    fs::write(control.join(CPU_WEIGHT), "100\n").unwrap();
    fs::write(guests.join(CPU_WEIGHT), "100\n").unwrap();
    fs::write(guests.join(CGROUP_SUBTREE_CONTROL), "").unwrap();
    fs::write(guests.join(CGROUP_PROCS), "").unwrap();
    let proc = temp.path().join("self.cgroup");
    fs::write(&proc, "0::/system.slice/vm0-runner.service/control\n").unwrap();
    (temp, proc, mount)
}

#[test]
fn initializes_existing_delegated_hierarchy_and_weights() {
    let (_temp, proc, mount) = fake_delegated_tree();
    let config = HostCpuPlacementConfig::new(200, 9800, HostCpuPlacementMode::Required).unwrap();

    let manager = HostCpuCgroupManager::initialize_at(config, &proc, &mount).unwrap();

    let root = manager.guests_path.parent().unwrap();
    assert_eq!(
        fs::read_to_string(root.join(CGROUP_SUBTREE_CONTROL)).unwrap(),
        "+cpu"
    );
    assert_eq!(
        fs::read_to_string(root.join(CONTROL_GROUP).join(CPU_WEIGHT)).unwrap(),
        "200"
    );
    assert_eq!(
        fs::read_to_string(root.join(GUESTS_GROUP).join(CPU_WEIGHT)).unwrap(),
        "9800"
    );
    assert_eq!(
        fs::read_to_string(root.join(GUESTS_GROUP).join(CGROUP_SUBTREE_CONTROL)).unwrap(),
        "+cpu"
    );
}

#[test]
fn acquired_lease_retires_its_leaf_and_preserves_caller_owned_clone() {
    for explicit_release in [true, false] {
        let (_temp, proc, mount) = fake_delegated_tree();
        let config =
            HostCpuPlacementConfig::new(100, 9900, HostCpuPlacementMode::Required).unwrap();
        let manager = HostCpuCgroupManager::initialize_at(config, &proc, &mount).unwrap();
        let id = SandboxId::new_v4();
        let lease = manager.acquire(id, 2).unwrap();
        let leaf = manager.guests_path.join(id.to_string());
        let placement = lease.clone_placement_directory().unwrap();

        assert_eq!(fs::read_to_string(leaf.join(CPU_WEIGHT)).unwrap(), "2");
        assert_eq!(
            placement.metadata().unwrap().ino(),
            fs::metadata(&leaf).unwrap().ino()
        );
        // Regular filesystem fixtures have real control files; cgroupfs's
        // virtual cpu.weight does not make an otherwise empty leaf busy.
        fs::remove_file(leaf.join(CPU_WEIGHT)).unwrap();

        if explicit_release {
            lease.release().unwrap();
        } else {
            drop(lease);
        }

        assert!(!leaf.exists());
        assert!(placement.metadata().unwrap().is_dir());
    }
}

#[test]
fn acquired_lease_release_surfaces_populated_leaf_removal_failure() {
    let (_temp, proc, mount) = fake_delegated_tree();
    let config = HostCpuPlacementConfig::new(100, 9900, HostCpuPlacementMode::Required).unwrap();
    let manager = HostCpuCgroupManager::initialize_at(config, &proc, &mount).unwrap();
    let id = SandboxId::new_v4();
    let lease = manager.acquire(id, 2).unwrap();
    let leaf = manager.guests_path.join(id.to_string());

    assert_eq!(
        lease.release().unwrap_err().kind(),
        io::ErrorKind::DirectoryNotEmpty
    );
    assert_eq!(fs::read_to_string(leaf.join(CPU_WEIGHT)).unwrap(), "2");
}

#[test]
fn missing_control_membership_is_unavailable() {
    let temp = tempfile::tempdir().unwrap();
    let proc = temp.path().join("self.cgroup");
    fs::write(&proc, "0::/user.slice/session.scope\n").unwrap();
    let config = HostCpuPlacementConfig::new(100, 9900, HostCpuPlacementMode::Required).unwrap();

    let error = HostCpuCgroupManager::initialize_at(config, &proc, temp.path()).unwrap_err();

    assert!(matches!(error, InitializationError::Unavailable(_)));
}

#[test]
fn placement_mode_only_allows_unavailable_local_fallback() {
    let temp = tempfile::tempdir().unwrap();
    let proc = temp.path().join("self.cgroup");
    fs::write(&proc, "0::/user.slice/session.scope\n").unwrap();

    let required = HostCpuPlacementConfig::new(100, 9900, HostCpuPlacementMode::Required).unwrap();
    assert!(HostCpuCgroupManager::initialize_with_paths(required, &proc, temp.path()).is_err());

    let preferred =
        HostCpuPlacementConfig::new(100, 9900, HostCpuPlacementMode::PreferManaged).unwrap();
    assert!(
        HostCpuCgroupManager::initialize_with_paths(preferred, &proc, temp.path())
            .unwrap()
            .is_none()
    );
}

#[test]
fn prefer_managed_rejects_delegation_without_control_subgroup() {
    let (_temp, proc, mount) = fake_delegated_tree();
    fs::write(&proc, "0::/system.slice/vm0-runner.service\n").unwrap();
    let config =
        HostCpuPlacementConfig::new(100, 9900, HostCpuPlacementMode::PreferManaged).unwrap();

    assert!(HostCpuCgroupManager::initialize_with_paths(config, &proc, &mount).is_err());
    assert_eq!(
        fs::read_to_string(mount.join("system.slice/vm0-runner.service/cgroup.subtree_control"))
            .unwrap(),
        ""
    );
}

#[test]
fn prefer_managed_rejects_wrong_delegated_subgroup() {
    let (_temp, proc, mount) = fake_delegated_tree();
    let root = mount.join("system.slice/vm0-runner.service");
    fs::create_dir(root.join("worker")).unwrap();
    fs::write(&proc, "0::/system.slice/vm0-runner.service/worker\n").unwrap();
    let config =
        HostCpuPlacementConfig::new(100, 9900, HostCpuPlacementMode::PreferManaged).unwrap();

    assert!(HostCpuCgroupManager::initialize_with_paths(config, &proc, &mount).is_err());
    assert_eq!(
        fs::read_to_string(root.join(CGROUP_SUBTREE_CONTROL)).unwrap(),
        ""
    );
}

#[test]
fn prefer_managed_fails_after_hierarchy_mutation_begins() {
    let (_temp, proc, mount) = fake_delegated_tree();
    let root = mount.join("system.slice/vm0-runner.service");
    let control_weight = root.join(CONTROL_GROUP).join(CPU_WEIGHT);
    fs::remove_file(&control_weight).unwrap();
    fs::create_dir(&control_weight).unwrap();
    let config =
        HostCpuPlacementConfig::new(100, 9900, HostCpuPlacementMode::PreferManaged).unwrap();

    assert!(HostCpuCgroupManager::initialize_with_paths(config, &proc, &mount).is_err());
    assert_eq!(
        fs::read_to_string(root.join(CGROUP_SUBTREE_CONTROL)).unwrap(),
        "+cpu"
    );
}

#[test]
fn rejects_populated_canonical_guest_leaf_without_removing_it() {
    let (_temp, proc, mount) = fake_delegated_tree();
    let guests = mount.join("system.slice/vm0-runner.service/guests");
    let stale = guests.join(SandboxId::new_v4().to_string());
    fs::create_dir(&stale).unwrap();
    fs::write(stale.join(CGROUP_PROCS), "123\n").unwrap();
    let config = HostCpuPlacementConfig::new(100, 9900, HostCpuPlacementMode::Required).unwrap();

    assert!(matches!(
        HostCpuCgroupManager::initialize_at(config, &proc, &mount),
        Err(InitializationError::Invalid(_))
    ));
    assert!(stale.exists());
}

#[test]
fn rejects_populated_or_unknown_delegated_state() {
    let (_temp, proc, mount) = fake_delegated_tree();
    let root = mount.join("system.slice/vm0-runner.service");
    fs::write(root.join(CGROUP_PROCS), "123\n").unwrap();
    let config = HostCpuPlacementConfig::new(100, 9900, HostCpuPlacementMode::Required).unwrap();
    assert!(matches!(
        HostCpuCgroupManager::initialize_at(config, &proc, &mount),
        Err(InitializationError::Invalid(_))
    ));

    fs::write(root.join(CGROUP_PROCS), "").unwrap();
    fs::create_dir(root.join("unknown")).unwrap();
    assert!(matches!(
        HostCpuCgroupManager::initialize_at(config, &proc, &mount),
        Err(InitializationError::Invalid(_))
    ));
}

#[test]
fn rejects_symlinked_guest_entry() {
    let (_temp, proc, mount) = fake_delegated_tree();
    let guests = mount.join("system.slice/vm0-runner.service/guests");
    symlink("/tmp", guests.join("unsafe")).unwrap();
    let config = HostCpuPlacementConfig::new(100, 9900, HostCpuPlacementMode::Required).unwrap();

    assert!(matches!(
        HostCpuCgroupManager::initialize_at(config, &proc, &mount),
        Err(InitializationError::Invalid(_))
    ));
}
