use std::{env, fs, path::PathBuf, process::Command};

use sha2::{Digest, Sha256};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo::rustc-check-cfg=cfg(native_kerberos)");
    for input in [
        "native/build.sh",
        "native/isolation.h",
        "native/worker.c",
        "native/NOTICE-MIT",
        "native/NOTICE-musl",
        "native/NOTICE-Zig",
    ] {
        println!("cargo::rerun-if-changed={input}");
    }
    let target = env::var("TARGET")?;
    let arch = match target.as_str() {
        "x86_64-unknown-linux-gnu" | "x86_64-unknown-linux-musl" => "x86_64",
        "aarch64-unknown-linux-gnu" | "aarch64-unknown-linux-musl" => "aarch64",
        _ => return Ok(()),
    };
    let out = PathBuf::from(env::var_os("OUT_DIR").ok_or("missing Cargo output directory")?);
    let status = Command::new("bash")
        .arg("native/build.sh")
        .arg(out.join("native"))
        .arg(arch)
        .status()?;
    if !status.success() {
        return Err("pinned native Kerberos build failed".into());
    }
    let binary = fs::read(out.join("native/kerberos-worker"))?;
    if binary.len() > 16 * 1024 * 1024 {
        return Err("native worker package exceeds its byte budget".into());
    }
    let digest: String = Sha256::digest(binary)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let notices = ["NOTICE-MIT", "NOTICE-musl", "NOTICE-Zig"]
        .map(|name| fs::read_to_string(out.join("native").join(name)))
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?
        .join("\n");
    let notice_digest: String = Sha256::digest(notices.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    println!("cargo::rustc-env=KERBEROS_WORKER_NOTICES_SHA256={notice_digest}");
    println!("cargo::rustc-env=KERBEROS_WORKER_SHA256={digest}");
    println!("cargo::rustc-env=KERBEROS_WORKER_TARGET={arch}-unknown-linux-musl");
    println!("cargo::rustc-cfg=native_kerberos");
    Ok(())
}
