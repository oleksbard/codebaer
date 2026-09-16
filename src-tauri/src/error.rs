use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", content = "detail")]
pub enum AppError {
    Git(String),
    Io(String),
    InvalidPath(String),
    Timeout,
    Cancelled,
    NotARepo,
    Stale(crate::git::FileText),
    StaleIndex,
    NotUtf8,
    Binary,
    TooLarge,
    Special,
    Conflicted,
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}
