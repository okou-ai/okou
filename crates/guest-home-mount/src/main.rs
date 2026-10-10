//! Fixed privileged home mount helper. No caller-selected arguments.

fn main() {
    if std::env::args_os().len() != 1 {
        eprintln!("home mount helper accepts no arguments");
        std::process::exit(64);
    }
    if let Err(error) = guest_home_mount::mount_home_drive() {
        eprintln!("home mount failed: {error}");
        std::process::exit(1);
    }
}
