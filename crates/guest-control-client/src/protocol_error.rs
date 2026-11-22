//! Client I/O classifications for display-only codec errors.

use std::io;

use guest_control_proto::ProtocolError;

pub(crate) fn invalid_input(error: ProtocolError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, error.to_string())
}

pub(crate) fn invalid_data(error: ProtocolError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}
