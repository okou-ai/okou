use super::*;
use std::io::Write;

#[tokio::test]
async fn append_scan_matches_a_marker_split_across_reads() -> io::Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("agent.jsonl");
    std::fs::write(&path, b"first entry\nbatching-senti")?;
    let marker = "batching-sentinel";
    let matcher = aho_corasick::AhoCorasick::new([marker]).unwrap();
    let overlap = Some((marker.len() - 1) as u64);
    let (found, previous) = file_contains(&path, &matcher, overlap, None).await?;
    assert!(!found);

    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)?
        .write_all(b"nel\n")?;
    let (found, _) = file_contains(&path, &matcher, overlap, previous).await?;
    assert!(found);
    Ok(())
}

#[tokio::test]
async fn append_scan_restarts_on_replacement_or_shrink() -> io::Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("agent.jsonl");
    let replacement = dir.path().join("replacement.jsonl");
    let marker = "ready";
    let matcher = aho_corasick::AhoCorasick::new([marker]).unwrap();
    let overlap = Some((marker.len() - 1) as u64);
    let prefix = [b'x'; 1024];

    std::fs::write(&path, prefix)?;
    let (found, previous) = file_contains(&path, &matcher, overlap, None).await?;
    assert!(!found);
    let mut new_contents = b"ready\n".to_vec();
    new_contents.extend(prefix);
    std::fs::write(&replacement, new_contents)?;
    std::fs::rename(&replacement, &path)?;
    let (found, _) = file_contains(&path, &matcher, overlap, previous).await?;
    assert!(found);

    std::fs::write(&path, prefix)?;
    let (found, previous) = file_contains(&path, &matcher, overlap, None).await?;
    assert!(!found);
    std::fs::write(&path, b"ready\n")?;
    let (found, _) = file_contains(&path, &matcher, overlap, previous).await?;
    assert!(found);
    Ok(())
}
