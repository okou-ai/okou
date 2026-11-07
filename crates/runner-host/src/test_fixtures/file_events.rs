//! Strict observation of JSON filename accesses through a caller-owned inotify watch.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::Path;

use nix::errno::Errno;
use nix::sys::inotify::{AddWatchFlags, Inotify};

/// Drain pending events from a nonblocking watch into distinct JSON filenames.
///
/// The caller owns watch creation, its event masks and descriptor lifetime.
/// Panics on queue overflow or an unexpected read error.
pub fn json_file_accesses(watcher: &Inotify) -> BTreeSet<OsString> {
    let mut names = BTreeSet::new();
    loop {
        match watcher.read_events() {
            Ok(events) => {
                for event in events {
                    assert!(!event.mask.contains(AddWatchFlags::IN_Q_OVERFLOW));
                    if let Some(name) = event.name
                        && Path::new(&name)
                            .extension()
                            .is_some_and(|ext| ext == "json")
                    {
                        names.insert(name);
                    }
                }
            }
            Err(Errno::EAGAIN) => return names,
            Err(error) => panic!("read payload access events: {error}"),
        }
    }
}
