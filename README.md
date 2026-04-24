# CDP Launcher

A macOS desktop app for Cloudera Solutions Engineers to provision and destroy CDP 7.3.2 clusters on AWS — without touching the CLI.

Fill in a 4-step wizard, click Launch. The app drives the underlying Terraform + Ansible + Make automation, streams live phase-by-phase logs back to the UI, and detects common errors with remediation hints.

---

## What it does

- **Provision** — 4-step wizard collects cluster config and credentials, then runs all 11 install phases (Terraform init/plan/apply → Ansible bootstrap → CM install) with live log streaming
- **Monitor** — phase tracker with status icons, elapsed time, and per-phase log viewer; auto-detects SELinux, AMI, quota, and key-pair errors with remediation hints
- **Manage** — dashboard lists all clusters with state, cost estimate, and one-click destroy; cluster detail shows CM URL, SSH, env vars, phase history, and Keychain secrets

---

## Prerequisites

| Requirement | Notes |
|---|---|
| macOS 13+ | Apple Silicon or Intel |
| Xcode Command Line Tools | `xcode-select --install` |
| Rust + Cargo | Installed by `scripts/bootstrap-dev.sh` if missing |
| Node 20+ | Installed by `scripts/bootstrap-dev.sh` via nvm if missing |
| Terraform | `brew install terraform` |
| Ansible | `pip3 install ansible` |
| GNU Make | Ships with Xcode CLT |
| AWS CLI | `brew install awscli` |
| AWS named profile | Configured in `~/.aws/config` with EC2/VPC/IAM permissions |
| CDP installer repo | `cdp-732-automation` cloned locally |

---

## Install (released DMG)

1. Download the latest `cdp-launcher-<version>.dmg` from the [Releases](https://github.com/partomia/cdp-launcher-app/releases) page
2. Open the DMG and drag **CDP Launcher** to your Applications folder
3. **First launch:** right-click → **Open** to bypass Gatekeeper (ad-hoc signed, not notarized)

---

## Development

```bash
# 1. Clone
git clone git@github.com:partomia/cdp-launcher-app.git
cd cdp-launcher-app

# 2. Install Rust, Node, and JS dependencies
./scripts/bootstrap-dev.sh

# 3. Launch in hot-reload dev mode
source "$HOME/.cargo/env" && cargo tauri dev
```

First run downloads ~400 Rust crates (~3 min). Subsequent runs are incremental (seconds).

---

## Using the app

### New cluster
Sidebar → **New Install** → fill the 4-step wizard:

1. **Basics** — cluster name, installer repo path, AWS profile, region
2. **Infrastructure** — SSH key pair name, operator ingress CIDR (the app detects your public IP)
3. **Passwords** — 6 CDP service passwords (stored in macOS Keychain, never on disk)
4. **Review** → **Launch Install**

### Cluster detail (ready state)
- **Open CM UI** — spawns an SSH tunnel to `util1.<domain>:7183` and opens `https://localhost:7183/` in your browser
- **SSH to bastion** — opens Terminal.app with the `ssh` command pre-filled
- **Copy env vars** — copies `export CDP_*=...` block to clipboard
- **Destroy** — 2-step confirm dialog (type cluster name) → runs `make tf-destroy`

### Settings
Sidebar → **Settings**:
- Set default repo path, AWS profile, region
- View data directory location
- Danger zone: forget all secrets / delete all cluster metadata

---

## Configuration

App data lives at `~/Library/Application Support/com.partomia.cdp-launcher/`:

| What | Where |
|---|---|
| Cluster metadata + phase events | `launcher.db` (SQLite) |
| Phase log files | `logs/<cluster-id>/<phase>.log` |
| CDP passwords | macOS Keychain, service `com.partomia.cdp-launcher` |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `No rule to make target` | `make` not in PATH | Run via `source ~/.cargo/env && cargo tauri dev` |
| `InvalidKeyPair.NotFound` | Key pair not in the target region | Import your public key in EC2 → Key Pairs |
| `avc: denied` in logs | SELinux enforcing on cluster nodes | Use the "Apply Fix" button in the error hint banner |
| CM UI won't open | Bastion IP not yet captured | Bastion IP is stored after `terraform apply` — only available on ready clusters |
| First launch blocked | Gatekeeper quarantine | Right-click the app → Open |

See [DESIGN.md](DESIGN.md) for full architecture, data model, and roadmap.

---

## Build

```bash
# Development (hot-reload)
source "$HOME/.cargo/env" && cargo tauri dev

# Production (universal binary)
source "$HOME/.cargo/env" && cargo tauri build --target universal-apple-darwin

# Type check only
npx tsc --noEmit

# Rust lint
cargo clippy --manifest-path src-tauri/Cargo.toml
```

---

## Project layout

```
cdp-launcher-app/
  src/                          React frontend
    components/
      AppShell.tsx              Sidebar + top bar layout
      Sidebar.tsx               Nav, theme toggle
      PhaseTracker.tsx          Phase status list with polling
      LogPane.tsx               Virtualised live log viewer
      ErrorHintBanner.tsx       Known-error detection + remediation UI
      ui/button.tsx             shadcn/ui Button
    lib/
      tauri.ts                  Typed wrappers for all Tauri commands
      types.ts                  Interfaces: Cluster, PhaseEvent, ErrorHint, etc.
      theme.tsx                 ThemeProvider
      utils.ts                  cn() helper
    pages/
      Dashboard.tsx             Cluster table + cost estimates
      InstallWizard.tsx         4-step install wizard
      InstallProgress.tsx       Live install/destroy view
      ClusterDetail.tsx         Detail: overview, phase history, secrets
      Settings.tsx              Settings + danger zone

  src-tauri/                    Rust backend (Tauri 2.x)
    migrations/
      V1__initial.sql           clusters + phase_events schema
      V2__settings.sql          app_settings table
    src/
      commands/
        aws.rs                  AWS CLI wrappers
        cluster.rs              Cluster CRUD
        install.rs              install_start / destroy_start / logs_fetch
        keychain.rs             macOS Keychain commands
        ui.rs                   Settings, CM UI, SSH, env vars, remediation
      orchestrator/
        install.rs              11-phase install orchestrator
        destroy.rs              Destroy orchestrator
        tfvars.rs               terraform.tfvars writer
        error_hints.rs          Known-error regex patterns
      runner/
        process.rs              PTY subprocess runner + error hint scanning
      state/
        store.rs                SQLite Store
      error.rs                  AppError (Tauri IPC-serializable)
      lib.rs                    Tauri builder + command registration

  .github/workflows/
    ci.yml                      Lint + typecheck + test on PR/push
    release.yml                 Universal DMG build + GitHub Release on tag

  scripts/
    bootstrap-dev.sh            One-shot dev environment setup
  Makefile                      dev / build / clean shortcuts
  DESIGN.md                     Architecture and roadmap
```

---

## License

MIT © Partomia
