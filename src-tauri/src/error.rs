//! A single error type for every native command.
//!
//! Tauri requires command errors to be `Serialize`, and the frontend only ever
//! shows the message, so one string-backed type replaces the `map_err(|error|
//! error.to_string())` that used to appear on almost every fallible call.

use std::fmt;

/// A user-facing failure. Messages are written for the person using the
/// application, not for a log file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(String);

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl From<&str> for Error {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl From<String> for Error {
    fn from(value: String) -> Self {
        Self(value)
    }
}

macro_rules! from_source {
    ($($source:ty),* $(,)?) => {
        $(impl From<$source> for Error {
            fn from(value: $source) -> Self {
                Self(value.to_string())
            }
        })*
    };
}

from_source!(
    std::io::Error,
    serde_json::Error,
    zip::result::ZipError,
    reqwest::Error,
    rusqlite::Error,
    tauri::Error,
);

pub type Result<T> = std::result::Result<T, Error>;

/// Adds human-readable context to any failure without discarding the cause.
pub trait Context<T> {
    fn context(self, message: impl fmt::Display) -> Result<T>;
    fn with_context<D: fmt::Display>(self, message: impl FnOnce() -> D) -> Result<T>;
}

impl<T, E: fmt::Display> Context<T> for std::result::Result<T, E> {
    fn context(self, message: impl fmt::Display) -> Result<T> {
        self.map_err(|error| Error(format!("{message}: {error}")))
    }

    fn with_context<D: fmt::Display>(self, message: impl FnOnce() -> D) -> Result<T> {
        self.map_err(|error| Error(format!("{}: {error}", message())))
    }
}

impl<T> Context<T> for Option<T> {
    fn context(self, message: impl fmt::Display) -> Result<T> {
        self.ok_or_else(|| Error(message.to_string()))
    }

    fn with_context<D: fmt::Display>(self, message: impl FnOnce() -> D) -> Result<T> {
        self.ok_or_else(|| Error(message().to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::{Context, Error};

    #[test]
    fn context_keeps_both_the_message_and_the_cause() {
        let failure: std::result::Result<(), &str> = Err("permission denied");

        let error = failure.context("Unable to read /media/gotek").unwrap_err();

        assert_eq!(
            error.to_string(),
            "Unable to read /media/gotek: permission denied"
        );
    }

    #[test]
    fn missing_options_become_plain_messages() {
        let error = None::<u8>.context("No download URL").unwrap_err();

        assert_eq!(error, Error::new("No download URL"));
    }
}
