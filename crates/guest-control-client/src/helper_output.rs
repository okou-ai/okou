use std::io;

use guest_control_proto::ExecCapturedOutput;

pub(super) fn owned_capture(
    output: ExecCapturedOutput<'_>,
    operation: &str,
    field: &str,
) -> io::Result<(Vec<u8>, bool)> {
    match output {
        ExecCapturedOutput::Captured { bytes, truncated } => Ok((bytes.to_vec(), truncated)),
        ExecCapturedOutput::Discarded => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{operation} result discarded {field}"),
        )),
    }
}
