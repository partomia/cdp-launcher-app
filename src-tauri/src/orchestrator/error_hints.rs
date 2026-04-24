use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorHint {
    pub name: String,
    pub severity: String,
    pub summary: String,
    pub remediation: String,
    pub remediation_command: Option<String>,
}

struct HintDef {
    name: &'static str,
    pattern: Regex,
    severity: &'static str,
    summary: &'static str,
    remediation: &'static str,
    remediation_command: Option<&'static str>,
}

static HINTS: Lazy<Vec<HintDef>> = Lazy::new(|| {
    vec![
        HintDef {
            name: "selinux_enforcing",
            pattern: Regex::new(r"avc:\s+denied.*cm-auto").unwrap(),
            severity: "blocker",
            summary: "SELinux is blocking Auto-TLS file access",
            remediation: "Set SELinux to permissive on all cluster nodes",
            remediation_command: Some(
                "ansible all -b -m shell -a 'setenforce 0; sed -i s/^SELINUX=.*/SELINUX=permissive/ /etc/selinux/config'",
            ),
        },
        HintDef {
            name: "autotls_perm_denied",
            pattern: Regex::new(r"cm-auto-global_truststore\.jks.*Permission denied").unwrap(),
            severity: "blocker",
            summary: "Auto-TLS agent-cert directory has wrong permissions",
            remediation: "Fix permissions on agent-cert directory on all nodes",
            remediation_command: Some(
                "ansible all -b -m shell -a 'chmod 0755 /opt/cloudera/security/pki; chmod 0644 /opt/cloudera/security/pki/*.jks'",
            ),
        },
        HintDef {
            name: "aws_quota_exceeded",
            pattern: Regex::new(r"VcpuLimitExceeded|running-instances limit").unwrap(),
            severity: "blocker",
            summary: "AWS vCPU or instance quota exceeded in this region",
            remediation: "Request a quota increase in the AWS Service Quotas console, or choose a region with capacity",
            remediation_command: None,
        },
        HintDef {
            name: "invalid_keypair",
            pattern: Regex::new(r"InvalidKeyPair\.NotFound").unwrap(),
            severity: "blocker",
            summary: "SSH key pair not found in this AWS region",
            remediation: "Import your public key to EC2 Key Pairs in the target region",
            remediation_command: None,
        },
        HintDef {
            name: "missing_ami",
            pattern: Regex::new(r"ImageId.*does not exist|No AMIs found").unwrap(),
            severity: "blocker",
            summary: "AMI not found in this region",
            remediation: "The CDP AMI may not be published in this region — check your aws_region and ami_filter in tfvars",
            remediation_command: None,
        },
        HintDef {
            name: "unauthorized_ec2",
            pattern: Regex::new(r"UnauthorizedOperation").unwrap(),
            severity: "blocker",
            summary: "AWS permissions error — EC2 operation denied",
            remediation: "Ensure your AWS profile has the required EC2/VPC/IAM permissions for CDP installation",
            remediation_command: None,
        },
        HintDef {
            name: "nat_gw_limit",
            pattern: Regex::new(r"NatGatewayLimitExceeded").unwrap(),
            severity: "blocker",
            summary: "NAT Gateway limit exceeded in this region/VPC",
            remediation: "Delete unused NAT Gateways or request a quota increase via AWS Service Quotas",
            remediation_command: None,
        },
    ]
});

/// Check a single log line against all known error patterns.
/// Returns the first matching hint, if any.
pub fn check_line(line: &str) -> Option<ErrorHint> {
    for def in HINTS.iter() {
        if def.pattern.is_match(line) {
            return Some(ErrorHint {
                name: def.name.to_string(),
                severity: def.severity.to_string(),
                summary: def.summary.to_string(),
                remediation: def.remediation.to_string(),
                remediation_command: def.remediation_command.map(|s| s.to_string()),
            });
        }
    }
    None
}
