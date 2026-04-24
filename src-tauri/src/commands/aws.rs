use serde::{Deserialize, Serialize};
use std::process::Command;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallerIdentity {
    pub account: String,
    pub arn: String,
    pub user_id: String,
}

// Internal — matches the AWS CLI JSON response
#[derive(Deserialize)]
struct StsResponse {
    #[serde(rename = "UserId")]
    user_id: String,
    #[serde(rename = "Account")]
    account: String,
    #[serde(rename = "Arn")]
    arn: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn run_aws(args: &[&str]) -> Result<std::process::Output, AppError> {
    Command::new("aws")
        .args(args)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::AwsCliNotInstalled
            } else {
                AppError::Io(e)
            }
        })
}

fn stderr_str(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

fn stdout_str(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Returns all named profiles from ~/.aws/config
#[tauri::command]
pub fn aws_profile_list() -> Result<Vec<String>, AppError> {
    let output = run_aws(&["configure", "list-profiles"])?;

    if !output.status.success() {
        return Err(AppError::Other(stderr_str(&output)));
    }

    let profiles: Vec<String> = stdout_str(&output)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
        .collect();

    Ok(profiles)
}

/// Runs `aws sts get-caller-identity` for the given profile/region
#[tauri::command]
pub fn aws_caller_identity(profile: String, region: String) -> Result<CallerIdentity, AppError> {
    let output = run_aws(&[
        "--profile", &profile,
        "--region", &region,
        "sts", "get-caller-identity",
        "--output", "json",
    ])?;

    if !output.status.success() {
        let stderr = stderr_str(&output);
        if stderr.contains("could not be found") || stderr.contains("ProfileNotFound") {
            return Err(AppError::AwsProfileNotFound(profile));
        }
        if stderr.contains("ExpiredToken")
            || stderr.contains("InvalidClientTokenId")
            || stderr.contains("AccessDenied")
            || stderr.contains("AuthFailure")
        {
            return Err(AppError::AwsAuthFailed(stderr));
        }
        return Err(AppError::Other(stderr));
    }

    let sts: StsResponse = serde_json::from_str(&stdout_str(&output))
        .map_err(|e| AppError::Other(format!("parse error: {e}")))?;

    Ok(CallerIdentity {
        account: sts.account,
        arn: sts.arn,
        user_id: sts.user_id,
    })
}

/// Returns true if the named key pair exists in the given region
#[tauri::command]
pub fn aws_check_key_pair(profile: String, region: String, key_name: String) -> Result<bool, AppError> {
    let output = run_aws(&[
        "--profile", &profile,
        "--region", &region,
        "ec2", "describe-key-pairs",
        "--key-names", &key_name,
        "--output", "json",
    ])?;

    // Exit 0 → found, non-zero → not found or error
    Ok(output.status.success())
}

/// Detects the caller's public IP via external services; returns "x.x.x.x/32"
#[tauri::command]
pub fn aws_detect_public_ip() -> Result<String, AppError> {
    let sources = ["https://ifconfig.me", "https://api.ipify.org"];

    for url in &sources {
        let result = Command::new("curl")
            .args(["--silent", "--max-time", "5", url])
            .output();

        if let Ok(output) = result {
            if output.status.success() {
                let ip = stdout_str(&output);
                if !ip.is_empty() && ip.chars().all(|c| c.is_ascii_digit() || c == '.') {
                    return Ok(format!("{ip}/32"));
                }
            }
        }
    }

    Err(AppError::Network(
        "could not detect public IP from ifconfig.me or api.ipify.org".into(),
    ))
}
