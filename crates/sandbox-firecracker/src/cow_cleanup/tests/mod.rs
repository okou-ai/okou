use super::*;

#[derive(Clone, Copy)]
struct FakeCowDestroyError {
    backing_files_safe_to_delete: bool,
}

impl CowDestroyErrorSafety for FakeCowDestroyError {
    fn backing_files_safe_to_delete(&self) -> bool {
        self.backing_files_safe_to_delete
    }
}

#[test]
fn cow_destroy_success_makes_backing_files_safe_to_delete() {
    let result: std::result::Result<(), FakeCowDestroyError> = Ok(());

    let outcome = classify_cow_destroy_result(&result);

    assert_eq!(outcome, CowCleanupOutcome::BackingFilesSafeToDelete);
    assert!(outcome.backing_files_safe_to_delete());
}

#[test]
fn cow_destroy_storage_cleanup_failure_makes_backing_files_safe_to_delete() {
    let result = Err(FakeCowDestroyError {
        backing_files_safe_to_delete: true,
    });

    let outcome = classify_cow_destroy_result(&result);

    assert_eq!(outcome, CowCleanupOutcome::BackingFilesSafeToDelete);
    assert!(outcome.backing_files_safe_to_delete());
}

#[test]
fn cow_destroy_device_cleanup_failure_preserves_backing_files() {
    let result = Err(FakeCowDestroyError {
        backing_files_safe_to_delete: false,
    });

    let outcome = classify_cow_destroy_result(&result);

    assert_eq!(
        outcome,
        CowCleanupOutcome::DeviceMayStillReferenceBackingFiles
    );
    assert!(!outcome.backing_files_safe_to_delete());
}
