//! Fixed privileged Home filesystem helper.
fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let result = match args.as_slice() {
        [] => guest_home_mount::mount_home_drive(),
        [arg] if arg == "--unmount" => guest_home_mount::unmount_home_drive(),
        _ => {
            eprintln!("unsupported home helper operation");
            std::process::exit(64);
        }
    };
    if let Err(error) = result {
        eprintln!("home filesystem operation failed: {error}");
        std::process::exit(1);
    }
}
