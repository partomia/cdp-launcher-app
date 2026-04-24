# CDP Launcher — Design Document

## 1. Purpose

CDP Launcher is a macOS desktop application for Cloudera Solutions Engineers (SEs) who need to provision and tear down Cloudera Data Platform (CDP) 7.3.2 clusters on AWS without running CLI commands by hand.

The SE fills in a 5-step wizard form (AWS credentials, cluster topology, service credentials, license, and a final review), clicks "Install", and the app drives the existing `cdp-732-automation` installer repo (Terraform + Ansible + Make) end-to-end. The cluster state, phase logs, and progress are surfaced in the app. Destroying a cluster is a single button press.

**Primary users:** Cloudera SEs running proof-of-concept or demo environments for customers.  
**Non-goals (v1):** multi-user support, non-AWS clouds, CDP versions other than 7.3.2.

---

## 2. Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        macOS Desktop                             │
│                                                                  │
│  ┌─────────────────────────────────┐                            │
│  │         React Frontend          │                            │
│  │  (Vite + TS + Tailwind + shadcn)│                            │
│  │                                 │                            │
│  │  Dashboard ──► Install Wizard   │                            │
│  │  Progress  ──► Cluster Detail   │                            │
│  │  Settings                       │                            │
│  └──────────────┬──────────────────┘                            │
│                 │  Tauri invoke / event                          │
│  ┌──────────────▼──────────────────┐                            │
│  │         Tauri Core (Rust)        │                            │
│  │                                 │                            │
│  │  commands/   ← IPC handlers     │                            │
│  │  state/      ← app state mgmt   │                            │
│  │  keyring     ← macOS Keychain   │                            │
│  │                                 │                            │
│  │  ┌──────────┐  ┌─────────────┐  │                            │
│  │  │  SQLite  │  │  Log stream │  │                            │
│  │  │(rusqlite)│  │ (Tauri evts)│  │                            │
│  │  └──────────┘  └──────┬──────┘  │                            │
│  └─────────────────────┬─┼─────────┘                            │
│                         │ │ spawn subprocess                     │
│  ┌──────────────────────▼─▼─────────────────────────────────┐   │
│  │              installer repo (cdp-732-automation)          │   │
│  │                                                           │   │
│  │   make inventory → make ping → make bootstrap →           │   │
│  │   make prereq → make freeipa → make databases →           │   │
│  │   make cm → make kerberos → make post-install             │   │
│  │                                                           │   │
│  │   terraform/   (terraform.tfvars written by launcher)     │   │
│  │   ansible/     (inventory written by launcher)            │   │
│  └─────────────────────────────┬─────────────────────────────┘   │
│                                │  AWS API calls                  │
└────────────────────────────────┼────────────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │          AWS            │
                    │  EC2, VPC, S3, IAM, RDS │
                    │  (via named AWS profile) │
                    └─────────────────────────┘
```

---

## 3. Screens

### Dashboard
Shows all clusters in the local SQLite database with their status (Pending / Installing / Running / Failed / Destroyed). Provides buttons to create a new cluster or select an existing one. Shows a summary card per cluster: name, region, instance types, phase, last-updated timestamp.

### Install Wizard — 5 Steps

**Step 1 — AWS**  
AWS named profile selector (reads `~/.aws/config`), region picker, VPC/subnet ID fields, key-pair name, bastion IP or hostname.

**Step 2 — Topology**  
Master count + instance type, worker count + instance type, optional edge node toggle, EBS volume sizes.

**Step 3 — Credentials**  
CM admin password, FreeIPA admin password, OS user password. All fields are `type="password"` and written to macOS Keychain (never stored in SQLite in plaintext).

**Step 4 — License**  
File-path picker for the Cloudera `.license` file. The path is stored; the file is not copied.

**Step 5 — Review**  
Read-only summary of all wizard inputs. "Install" button triggers the install sequence.

### Install Progress
Real-time log stream per phase. Phase list on the left with status icons (pending / running / success / error). Log panel on the right auto-scrolls. "Abort" button sends SIGTERM to the current subprocess.

### Cluster Detail
Shows cluster metadata, SSH command snippets, CM URL, phase history, and a "Destroy" button that runs `make tf-destroy`.

### Settings
Installer repo path (defaults to `~/IdeaProjects/CDP7.3.2-Installation/cdp-732-automation`). Default AWS profile. Theme toggle (light/dark). App version + build.

---

## 4. Data Model

### `clusters` table

| Column            | Type    | Notes                                      |
|-------------------|---------|--------------------------------------------|
| id                | TEXT PK | UUID v4                                    |
| name              | TEXT    | Human-readable label                       |
| aws_profile       | TEXT    | Named profile from `~/.aws/config`         |
| region            | TEXT    | e.g. `us-east-1`                           |
| vpc_id            | TEXT    |                                            |
| subnet_id         | TEXT    |                                            |
| key_pair          | TEXT    |                                            |
| bastion_host      | TEXT    |                                            |
| master_count      | INT     |                                            |
| master_type       | TEXT    | EC2 instance type                          |
| worker_count      | INT     |                                            |
| worker_type       | TEXT    | EC2 instance type                          |
| has_edge          | BOOL    |                                            |
| ebs_size_gb       | INT     |                                            |
| license_path      | TEXT    | Absolute path to `.license` file           |
| current_phase     | TEXT    | Last phase attempted                       |
| status            | TEXT    | pending/installing/running/failed/destroyed|
| created_at        | TEXT    | ISO-8601                                   |
| updated_at        | TEXT    | ISO-8601                                   |

### `phase_events` table

| Column       | Type    | Notes                                        |
|--------------|---------|----------------------------------------------|
| id           | INT PK  | Auto-increment                               |
| cluster_id   | TEXT FK | References `clusters.id`                    |
| phase        | TEXT    | e.g. `bootstrap`, `freeipa`                  |
| status       | TEXT    | started / success / failed                   |
| exit_code    | INT     | Subprocess exit code (NULL if started)       |
| log_path     | TEXT    | Path to captured stdout/stderr log file      |
| started_at   | TEXT    | ISO-8601                                     |
| finished_at  | TEXT    | ISO-8601 (NULL if still running)             |

---

## 5. Secrets Handling

All secrets are stored in the **macOS Keychain** via the `keyring` crate. The Keychain service name is `com.partomia.cdp-launcher`. Secrets keyed by `{cluster_id}/{secret_name}`:

- `cm_admin_password`
- `freeipa_admin_password`
- `os_user_password`

AWS credentials are **never** stored by the app. The installer is invoked with the `AWS_PROFILE` environment variable set to the named profile chosen in the wizard. The SE manages AWS credentials in `~/.aws/credentials` / `~/.aws/config` as they normally would.

The Cloudera license is referenced by **file path only**. The file is never read or copied by the app; it is passed to the installer as a path argument.

No secrets appear in SQLite, log files, or Tauri event payloads. Log lines matching patterns like `password=` are redacted before being forwarded to the frontend.

---

## 6. Subprocess Execution Model

### Phase State Machine

```
PENDING → RUNNING → SUCCESS
                 ↘ FAILED
```

Phases execute sequentially in the order defined by the installer's Makefile:
`inventory → ping → bootstrap → prereq → freeipa → databases → cm → kerberos → post-install`

Destroy runs: `tf-destroy`

### Log Streaming

Each `make <phase>` subprocess is spawned with `stdout` and `stderr` piped. The Tauri backend reads lines asynchronously and emits `phase-log` Tauri events to the frontend:

```json
{ "cluster_id": "...", "phase": "bootstrap", "line": "...", "ts": "..." }
```

The React frontend subscribes to these events via `@tauri-apps/api/event` and appends lines to a virtual-scroll log buffer.

### Error Pattern Detection

The backend scans each log line against a set of known failure patterns (e.g. `FAILED!`, `Error:`, `fatal:`, `Terraform Error`). On a match the current phase is marked FAILED and the subprocess is killed. The SE sees an error badge on the phase and the last 50 log lines highlighted.

### Abort

The frontend sends an `abort-install` Tauri command. The backend sends SIGTERM to the process group and waits 5 s before SIGKILL.

---

## 7. Multi-Repo Support

A `repos.json` file in the app's data directory describes available installer versions:

```json
[
  {
    "id": "cdp-732",
    "label": "CDP 7.3.2",
    "path": "/Users/rsingh/IdeaProjects/CDP7.3.2-Installation/cdp-732-automation",
    "phases": ["inventory","ping","bootstrap","prereq","freeipa","databases","cm","kerberos","post-install"],
    "destroy_target": "tf-destroy"
  }
]
```

The Settings screen lets the SE point to a different repo path. Future CDP versions (7.4.x, etc.) will be added as additional entries and selectable in the Install Wizard.

---

## 8. Build & Release

### Development (ad-hoc)

```bash
make dev     # cargo tauri dev — hot-reload Vite + Rust
make build   # cargo tauri build — universal binary (x86_64 + arm64)
make dmg     # package into dist/cdp-launcher.dmg
```

The initial distribution is ad-hoc signed for personal/team use:

```bash
codesign --deep --force --sign - dist/cdp-launcher.app
```

### v1 — Developer ID Notarization (planned)

1. Enroll in Apple Developer Program ($99/yr).
2. Generate a **Developer ID Application** certificate in Xcode.
3. Set `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` in CI secrets.
4. `cargo tauri build` with `tauri.conf.json` `"signingIdentity"` and `"notarizationAppleId"` set.
5. Staple the notarization ticket: `xcrun stapler staple`.

CI will run in `.github/workflows/release.yml` (to be added in Phase 2).

---

## 9. Roadmap

### Phase 1 — Scaffold & Shell (current)
- Tauri 2.x + React 18 + Vite 5 + TypeScript skeleton
- Tailwind CSS + shadcn/ui component library wired up
- Zustand store structure defined
- SQLite schema + refinery migrations in place
- Empty command stubs for all Tauri IPC calls
- `make dev` opens a working window

### Phase 2 — Install Wizard & Subprocess Engine
- All 5 wizard steps with validation (zod schemas)
- Tauri commands: `create_cluster`, `start_install`, `abort_install`, `get_cluster`, `list_clusters`
- Subprocess spawning with stdout/stderr streaming via Tauri events
- Phase state machine persisted to SQLite
- Real-time progress screen with log viewer
- Keychain integration for secrets

### Phase 3 — Cluster Lifecycle & Settings
- Cluster detail screen with SSH snippets and CM URL
- `destroy_cluster` command running `make tf-destroy`
- Settings screen with repo path override and AWS profile default
- `repos.json` multi-repo support
- Log redaction for secrets
- Error pattern detection with highlighted failure context

### Phase 4 — Polish & Distribution
- Developer ID code signing + notarization
- Auto-update via Tauri updater plugin
- GitHub Actions release workflow (`.github/workflows/release.yml`)
- Dark/light theme toggle
- Onboarding walkthrough for first-time users
- Export cluster config as sharable JSON (secrets excluded)
