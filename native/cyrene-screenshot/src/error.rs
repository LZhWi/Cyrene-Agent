#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("invalid arguments: {0}")]
    InvalidArguments(String),
    #[error("not-implemented: graphical capture initialization")]
    NotImplemented,
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidArguments(_) => "invalid-arguments",
            Self::NotImplemented => "not-implemented",
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
