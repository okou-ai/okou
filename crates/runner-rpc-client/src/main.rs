use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let mode = match (args.next(), args.next()) {
        (None, None) => 0,
        (Some(arg), None) if arg == "--stream" => 1,
        (Some(arg), None) if arg == "--browser-cdp" => 2,
        _ => {
            eprintln!("usage: runner-rpc-client [--stream | --browser-cdp]");
            return ExitCode::FAILURE;
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => return ExitCode::FAILURE,
    };
    let succeeded = runtime
        .block_on(async {
            match mode {
                1 => runner_rpc_client::stream::run().await,
                2 => runner_rpc_client::browser::run().await,
                _ => runner_rpc_client::run().await,
            }
        })
        .unwrap_or(false);
    // Cancelled Tokio stdin/stdout work must not hold runtime shutdown open.
    // The process exits immediately afterward; no request work is detached.
    runtime.shutdown_background();
    if succeeded {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
