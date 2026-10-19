use super::super::*;
use super::support::*;
use nix::errno::Errno;
use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use std::collections::BTreeSet;
use std::os::unix::fs::MetadataExt;

#[tokio::test]
async fn pressure_discovery_leaves_busy_surviving_subtrees_unopened() {
    let f = Fixture::new().await;
    let mut images = Vec::new();
    let mut subtrees = Vec::new();
    let mut held_guards = Vec::new();
    for i in 0..16 {
        let reuse = format!("home-{i:02}");
        let committed = f
            .commit(
                &reuse,
                b"retained-home",
                &format!("2026-10-09T09:00:{i:02}Z"),
            )
            .await;
        images.push(f.image(&reuse, &committed));
        let subtree = f
            .cache
            .home_image_cache_entry_dir(&f.key(&reuse))
            .join("allocation-subtree");
        std::fs::create_dir(&subtree).unwrap();
        std::fs::write(subtree.join("retained"), b"retained allocation").unwrap();
        subtrees.push(subtree);
        if i > 0 {
            held_guards.push(
                runner_host::lock::acquire(f.cache.entry_lock_path(&f.key(&reuse)))
                    .await
                    .unwrap(),
            );
        }
    }
    let victim = f.cache.entry_paths(&f.key("home-00"));
    let orphan = victim.image(&uuid::Uuid::new_v4().to_string()).unwrap();
    write_image(&orphan, b"orphan", SIZE);
    let allocated: u64 = [
        victim.entry_dir().to_path_buf(),
        victim.metadata(),
        images[0].clone(),
        orphan.clone(),
        subtrees[0].clone(),
        subtrees[0].join("retained"),
    ]
    .iter()
    .map(|path| std::fs::symlink_metadata(path).unwrap().blocks() * 512)
    .sum();
    f.cache.set_fs_stats_for_test(FsStats {
        total_bytes: 100 * GIB,
        available_bytes: 1,
        ..FsStats::default()
    });
    // Previewed orphan cleanup and the selected whole entry are counted once.
    assert_eq!(f.cache.gc(true).await.unwrap(), allocated);
    assert!(images.iter().all(|image| image.exists()));
    assert!(orphan.exists());

    // Observe actual directory access, without replacing filesystem operations
    // or coupling the regression to an internal measurement-call counter.
    let inotify = Inotify::init(InitFlags::IN_NONBLOCK | InitFlags::IN_CLOEXEC).unwrap();
    let watches: Vec<_> = subtrees
        .iter()
        .map(|path| {
            inotify
                .add_watch(path, AddWatchFlags::IN_OPEN | AddWatchFlags::IN_ONLYDIR)
                .unwrap()
        })
        .collect();
    f.cache.probe_home_cache_pressure().await.unwrap();
    f.cache.drain_pressure_reclamation().await;
    assert!(!victim.entry_dir().exists());
    for (image, subtree) in images.iter().zip(&subtrees).skip(1) {
        assert!(image.exists());
        assert_eq!(
            std::fs::read(subtree.join("retained")).unwrap(),
            b"retained allocation"
        );
    }
    let mut opened = BTreeSet::new();
    loop {
        match inotify.read_events() {
            Ok(events) => {
                for event in events {
                    assert!(!event.mask.contains(AddWatchFlags::IN_Q_OVERFLOW));
                    if event
                        .mask
                        .contains(AddWatchFlags::IN_OPEN | AddWatchFlags::IN_ISDIR)
                    {
                        opened.insert(event.wd);
                    }
                }
            }
            Err(Errno::EAGAIN) => break,
            Err(error) => panic!("read directory access events: {error}"),
        }
    }
    assert_eq!(
        opened.len(),
        1,
        "only the selected subtree may be traversed"
    );
    assert!(opened.contains(&watches[0]));
    drop(held_guards);
}
