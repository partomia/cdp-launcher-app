#!/usr/bin/env python3
"""
gen_license.py — CDP Launcher license token generator
------------------------------------------------------
Usage:
    python3 tools/gen_license.py --user ravi@example.com --org Partomia --days 90

Requirements:
    pip install cryptography   (only needed if you want to use RSA variant)
    No extra deps for the default HMAC-SHA256 mode.

The token format matches the Rust verifier in
src-tauri/src/commands/license.rs:

    <base64url_no_pad(json_payload)>.<base64url_no_pad(hmac_sha256_signature)>

Keep LICENSE_SECRET in sync with the Rust constant.
"""

import argparse
import base64
import hashlib
import hmac
import json
import sys
import time

# ---------------------------------------------------------------------------
# IMPORTANT: keep this in sync with
#   src-tauri/src/commands/license.rs → LICENSE_SECRET
# ---------------------------------------------------------------------------
LICENSE_SECRET = b"cdp-launcher-2026-partomia-f7a3d1b9e5c2-change-me"


def b64url(data: bytes) -> str:
    """Base64-URL encode without padding."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def generate_token(user: str, org: str, days: int) -> str:
    now = int(time.time())
    exp = now + days * 86_400

    payload = json.dumps({"user": user, "org": org, "iat": now, "exp": exp},
                         separators=(",", ":")).encode()

    sig = hmac.new(LICENSE_SECRET, payload, hashlib.sha256).digest()

    return f"{b64url(payload)}.{b64url(sig)}"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate a CDP Launcher license token"
    )
    parser.add_argument("--user", required=True, help="Username / email")
    parser.add_argument("--org", required=True, help="Organisation name")
    parser.add_argument(
        "--days",
        type=int,
        default=365,
        help="Validity in days (7–365, default 365)",
    )
    args = parser.parse_args()

    if not (7 <= args.days <= 365):
        print("ERROR: --days must be between 7 and 365", file=sys.stderr)
        sys.exit(1)

    token = generate_token(args.user, args.org, args.days)

    print()
    print("  CDP Launcher License Token")
    print("  " + "─" * 60)
    print(f"  User : {args.user}")
    print(f"  Org  : {args.org}")
    print(f"  Days : {args.days}")
    print()
    print("  Token (copy the entire line below):")
    print()
    print(f"  {token}")
    print()


if __name__ == "__main__":
    main()
