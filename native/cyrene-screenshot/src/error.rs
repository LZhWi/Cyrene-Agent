#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("invalid arguments: {0}")]
    InvalidArguments(String),
    #[error("unsupported protocol version {provided}; expected {expected}")]
    ProtocolVersionMismatch { provided: u32, expected: u32 },
    #[error("not-implemented: graphical capture initialization")]
    NotImplemented,
    #[error("Windows API failed: {0}")]
    Windows(#[from] windows::core::Error),
    #[error("I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("runtime failed: {0}")]
    Runtime(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidArguments(_) => "invalid-arguments",
            Self::ProtocolVersionMismatch { .. } => "protocol-version-mismatch",
            Self::NotImplemented => "not-implemented",
            Self::Windows(_) => "windows-api-failed",
            Self::Io(_) => "io-failed",
            Self::Runtime(_) => "runtime-failed",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("NDJSON line exceeds 65536 bytes")]
    LineTooLong,
    #[error("invalid command: {0}")]
    InvalidCommand(#[from] serde_json::Error),
}

impl ProtocolError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::LineTooLong => "line-too-long",
            Self::InvalidCommand(_) => "invalid-command",
        }
    }
}
