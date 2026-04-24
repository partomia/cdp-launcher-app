# CDP Launcher

A macOS desktop app for Cloudera Solutions Engineers to provision and destroy CDP 7.3.2 clusters on AWS — without touching the CLI.

Fill in a wizard, click Install. The app drives the underlying Terraform + Ansible + Make automation and streams live phase-by-phase progress back to the UI.

---

## What it does

- Guides you through a 5-step wizard to configure an AWS-hosted CDP 7.3.2 cluster
- Writes `terraform.tfvars` and Ansible inventory files automatically
- Runs the installer phases in sequence (`inventory → ping → bootstrap → prereq → freeipa → databases → cm → kerberos → post-install`) and streams logs in real time
- Stores all passwords in the macOS Keychain — nothing sensitive touches disk or SQLite
- Lets you destroy a cluster with a single button (`make tf-destroy`)

**Who this is for:** Cloudera SEs spinning up proof-of-concept or demo environments for customers.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| macOS 13+ | Apple Silicon or Intel |
| Xcode Command Line Tools | `xcode-select --install` |
| Rust + Cargo | Installed by `scripts/bootstrap-dev.sh` if missing |
| Node 18+ | Installed by `scripts/bootstrap-dev.sh` via nvm if missing |
| AWS CLI | `brew install awscli` |
| AWS named profile | Configured in `~/.aws/config` with credentials for your target account |
| CDP installer repo | Cloned at `~/IdeaProjects/CDP7.3.2-Installation/cdp-732-automation` (overridable in Settings) |
| Cloudera license file | A valid `.license` file on your local machine |

---

## Getting started

```bash
# 1. Clone this repo
git clone git@github.com:partomia/cdp-launcher-app.git
cd cdp-launcher-app

# 2. Install dependencies (Rust, Node, Tauri CLI)
./scripts/bootstrap-dev.sh

# 3. Launch in dev mode
make dev
```

`make dev` starts the Vite dev server and compiles the Rust backend. On first run Cargo downloads ~400 crates — expect 2–3 minutes. Subsequent runs are fast (incremental).

---

## Install wizard — 5 steps

Once the app opens:

1. **AWS** — pick your named AWS profile, region, VPC ID, subnet ID, key pair name, and bastion hostname/IP
2. **Topology** — set master count + instance type, worker count + instance type, optional edge node, EBS volume size
3. **Credentials** — enter CM admin password, FreeIPA admin password, OS user password (saved to macOS Keychain)
4. **License** — browse to your Cloudera `.license` file
5. **Review** — confirm all settings, then click **Install**

The app writes the Terraform vars and Ansible inventory, then runs each Make phase in order. You can watch live logs per phase and abort at any time.

---

## Destroying a cluster

Open the cluster from the Dashboard → **Cluster Detail** → click **Destroy**. The app runs `make tf-destroy` and marks the cluster as destroyed in the local database.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Cmd+1 | Dashboard |
| Cmd+N | New Install |
| Cmd+, | Settings |

---

## Build

```bash
make build   # universal binary (x86_64 + arm64)
make dmg     # packages into dist/cdp-launcher.dmg
make clean   # removes target/, dist/, node_modules/
make test    # cargo test + npm test
make lint    # clippy + eslint + prettier
```

---

## Data storage

| What | Where |
|---|---|
| Cluster metadata | `~/Library/Application Support/com.partomia.cdp-launcher/launcher.db` (SQLite) |
| Passwords & secrets | macOS Keychain, service `com.partomia.cdp-launcher` |
| Wizard progress | `localStorage` (passwords excluded) |

Verify the database is working:
```bash
sqlite3 ~/Library/Application\ Support/com.partomia.cdp-launcher/launcher.db ".tables"
# → clusters   phase_events   refinery_schema_history
```

---

## Project layout

```
cdp-launcher-app/
  src/                        React frontend
    components/
      AppShell.tsx            Sidebar + top bar layout
      Sidebar.tsx             Nav, theme toggle, version
      ui/button.tsx           shadcn/ui Button (new-york style)
    lib/
      tauri.ts                Typed wrappers for all Tauri commands
      types.ts                TypeScript interfaces (Cluster, PhaseEvent, etc.)
      theme.tsx               ThemeProvider (system / light / dark)
      utils.ts                cn() Tailwind merge helper
    pages/
      Dashboard.tsx           Cluster list (empty state for now)
      InstallWizard.tsx       5-step install wizard (coming next)
      ClusterDetail.tsx       Cluster detail + logs
      Settings.tsx            Settings + smoke tests

  src-tauri/                  Rust backend (Tauri 2.x)
    migrations/
      V1__initial.sql         clusters + phase_events schema
    src/
      commands/
        aws.rs                AWS CLI wrappers (profiles, identity, key pairs)
        cluster.rs            Cluster CRUD Tauri commands
        keychain.rs           macOS Keychain read/write commands
      state/
        store.rs              SQLite Store with all DB methods
      error.rs                AppError (serializable for Tauri IPC)
      lib.rs                  Tauri builder + command registration
    tauri.conf.json           Bundle config (com.partomia.cdp-launcher)

  scripts/
    bootstrap-dev.sh          One-shot dev environment setup
  Makefile                    dev / build / dmg / clean / test / lint
  DESIGN.md                   Full architecture and data model
```

---

## Current status

**Phase 1 — Scaffold** (complete)
- Tauri 2.x + React 18 + Vite 5 + TypeScript skeleton
- Tailwind CSS 3 + shadcn/ui new-york style

**Phase 2 — Layout shell** (complete)
- Sidebar with navigation, theme toggle, keyboard shortcuts
- react-router-dom v6 with 4 routes
- ThemeProvider (follows macOS system preference, manual toggle)

**Phase 3 — Rust backend** (complete)
- SQLite state store with refinery migrations
- macOS Keychain integration
- AWS CLI command wrappers
- Cluster CRUD Tauri commands
- Typed TypeScript client (`src/lib/tauri.ts`)

**Phase 4 — Install wizard** (next)
- 5-step form with validation, cost estimator, live AWS identity check
- Zustand wizard store with localStorage persistence
- Credential handling → Keychain on launch

See [DESIGN.md](DESIGN.md) for the full roadmap and architecture details.
