//! Physical immutable backing and boot-expectation checks on the real Guest.

use std::io;

use sandbox::{ExecTermination, Sandbox};

use super::{TestResult, filesystem::command};

pub(super) async fn exercise(sandbox: &dyn Sandbox, home_attached: bool) -> TestResult<()> {
    // Only this owned Guest's writable root marker changes. Its immutable base
    // stays untouched, and cleanup restores the original bytes on every outcome.
    let prepared = command(
        sandbox,
        r#"python3 - <<'PY'
import errno, os
from pathlib import Path
root = Path('/etc/okou/runtime-build-id')
runtime = Path('/run/okou/runtime/etc/okou/runtime-build-id')
original = root.read_bytes()
assert original == runtime.read_bytes() and len(original) == 65
assert root.stat().st_dev != runtime.stat().st_dev
assert os.statvfs('/run/okou/runtime').f_flag & os.ST_RDONLY
try:
    fd = os.open(runtime, os.O_WRONLY)
except OSError as error:
    assert error.errno == errno.EROFS, error
else:
    os.close(fd)
    raise AssertionError('immutable runtime file opened for writing')
devices = [p for p in (Path('/sys/class/block/vdb'), Path('/sys/class/block/vdc')) if (p/'ro').exists() and (p/'ro').read_text() == '1\n']
assert len(devices) == 1 and (devices[0]/'ro').read_text() == '1\n'
try:
    fd = os.open('/dev/' + devices[0].name, os.O_WRONLY)
except OSError as error:
    # Linux can also reject a writable open because this device is mounted.
    assert error.errno in (errno.EROFS, errno.EPERM, errno.EACCES, errno.EBUSY), error
else:
    os.close(fd)
    raise AssertionError('immutable runtime block device opened for writing')
root.write_bytes(b'changed in the writable workload filesystem\n')
assert runtime.read_bytes() == original
PY"#,
        true,
    )
    .await;

    let verified: TestResult<()> = match prepared {
        Err(error) => Err(error),
        Ok(()) => {
            async {
                if !home_attached {
                    // This typed operation requires an attached writable home.
                    // No-home boot/reuse still checks the real runtime device
                    // and mount above; it must not treat readonly vdb as home.
                    return Ok(());
                }
                // The fixed operation must use its captured boot expectation rather
                // than treating the now-corrupt writable marker as current authority.
                let result = sandbox.mount_home_drive().await?;
                if !matches!(result.termination, ExecTermination::Exited { exit_code: 0 }) {
                    return Err(io::Error::other(
                        "runtime revalidation lost the trusted boot identity",
                    )
                    .into());
                }
                Ok(())
            }
            .await
        }
    };
    let cleanup = command(
        sandbox,
        "cp /run/okou/runtime/etc/okou/runtime-build-id /etc/okou/runtime-build-id",
        true,
    )
    .await;
    verified?;
    cleanup?;
    println!(
        "RUNTIME_BACKING_FIRECRACKER_PASS readonly=device immutable=separate-inodes reuse=boot-identity root-marker=restored"
    );
    Ok(())
}
