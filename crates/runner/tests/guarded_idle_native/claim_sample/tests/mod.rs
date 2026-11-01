use std::{io::Write, time::Duration};

use super::*;

fn line(at: u64) -> String {
    format!(
        "{{\"monotonic_ns\":{at},\"processes\":[{{\"pid\":{}}}]}}\n",
        std::process::id()
    )
}

#[tokio::test]
async fn waits_for_a_complete_new_sample_without_losing_a_write() -> TestResult<()> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("samples.jsonl");
    let mut file = std::fs::File::create(&path)?;
    file.write_all(line(1).as_bytes())?;
    let next = line(2);
    file.write_all(next.trim_end().as_bytes())?;
    // The first poll must actually inspect this incomplete line; relying
    // on an undelivered inotify event could hide a premature release.
    let wait = wait(&path, 1);
    tokio::pin!(wait);
    assert!(futures_util::poll!(&mut wait).is_pending());
    file.write_all(b"\n")?;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), wait).await??,
        2
    );
    Ok(())
}

#[tokio::test]
async fn accepts_an_already_flushed_sample_and_rejects_symlinks() -> TestResult<()> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("samples.jsonl");
    std::fs::write(&path, line(2))?;
    assert_eq!(wait(&path, 1).await?, 2);
    let link = directory.path().join("linked.jsonl");
    std::os::unix::fs::symlink(&path, &link)?;
    assert!(wait(&link, 1).await.is_err());
    Ok(())
}
