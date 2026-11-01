use std::process::Command;

use super::run_cmd;

pub(crate) struct DmMappingGuard {
    name: String,
    removed: bool,
}

impl DmMappingGuard {
    pub(crate) fn create(name: &str, table: &str) -> Result<Self, String> {
        run_cmd("dmsetup", &["create", name, "--table", table])?;
        Ok(Self {
            name: name.to_string(),
            removed: false,
        })
    }

    pub(crate) fn device_path(&self) -> String {
        format!("/dev/mapper/{}", self.name)
    }

    pub(crate) fn remove(&mut self) -> Result<(), String> {
        if self.removed {
            return Ok(());
        }
        run_cmd("dmsetup", &["remove", &self.name])?;
        self.removed = true;
        Ok(())
    }
}

impl Drop for DmMappingGuard {
    fn drop(&mut self) {
        if !self.removed {
            let _ = run_cmd("dmsetup", &["remove", &self.name]);
        }
    }
}

pub(crate) fn cleanup_stale_dm_mappings() {
    let Ok(output) = Command::new("dmsetup").arg("ls").output() else {
        return;
    };
    if !output.status.success() {
        return;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let Some(name) = line.split_whitespace().next() else {
            continue;
        };
        let Some(pid) = bench_dm_owner_pid(name) else {
            continue;
        };
        if std::path::Path::new(&format!("/proc/{pid}")).exists() {
            continue;
        }

        eprintln!("  Cleaning up stale dm mapping {name} (owner pid={pid})...");
        let _ = run_cmd("dmsetup", &["remove", name]);
    }
}

fn bench_dm_owner_pid(name: &str) -> Option<u32> {
    name.strip_prefix("bench-cow-")?
        .split('-')
        .next()?
        .parse()
        .ok()
}

#[cfg(test)]
mod tests;
