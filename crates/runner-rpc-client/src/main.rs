use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let streaming = match (args.next(), args.next()) {
        (None, None) => false,
        (Some(arg), None) if arg == "--stream" => true,
        _ => {
            eprintln!("usage: runner-rpc-client [--stream]; provide one request on stdin");
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
            if streaming {
                runner_rpc_client::stream::run().await
            } else {
                runner_rpc_client::run().await
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
