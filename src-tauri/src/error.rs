use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("migration error: {0}")]
    Migration(String),

    #[error("keychain error: {0}")]
    Keychain(String),

    #[error("AWS CLI is not installed — run `brew install awscli`")]
    AwsCliNotInstalled,

    #[error("AWS profile '{0}' not found in ~/.aws/config")]
    AwsProfileNotFound(String),

    #[error("AWS authentication failed: {0}")]
    AwsAuthFailed(String),

    #[error("network error: {0}")]
    Network(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Other(String),
}

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Database(_) => "database",
            Self::Migration(_) => "migration",
            Self::Keychain(_) => "keychain",
            Self::AwsCliNotInstalled => "aws_cli_not_installed",
            Self::AwsProfileNotFound(_) => "aws_profile_not_found",
            Self::AwsAuthFailed(_) => "aws_auth_failed",
            Self::Network(_) => "network",
            Self::NotFound(_) => "not_found",
            Self::Io(_) => "io",
            Self::Other(_) => "other",
        }
    }
}

// Tauri commands require errors to be serializable
impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}
