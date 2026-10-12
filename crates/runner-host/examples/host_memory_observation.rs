//! Native procfs smoke surface; this does not calibrate a controller or profile.

use std::time::Duration;

use runner_host::host_memory::HostMemoryObservation;
use tokio::time::Instant;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    for sequence in 0..3 {
        let sample = HostMemoryObservation::read().await;
        let available = sample.available_bytes_at(Instant::now(), Duration::from_secs(1));
        println!(
            "{}",
            serde_json::json!({
                "sequence": sequence,
                "mem_available_bytes": available.as_ref().ok(),
                "valid": available.is_ok(),
                "read_duration_ns": sample.read_duration().as_nanos(),
                "calibrated": false,
            })
        );
        available?;
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Ok(())
}
