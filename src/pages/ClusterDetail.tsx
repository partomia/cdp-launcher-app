import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  CheckCircle,
  Server,
  Globe,
  Terminal,
  Clipboard,
  Trash2,
  Copy,
  Eye,
  EyeOff,
  ChevronsUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TemplatesPanel } from "@/components/TemplatesPanel";
import { ClusterHealthPanel } from "@/components/ClusterHealthPanel";
import { cn } from "@/lib/utils";
import {
  clusterGet,
  clusterPhaseEvents,
  keychainGet,
  openCmUi,
  openCmTunnel,
  openSshTerminal,
  clusterEnvVars,
  destroyStart,
  scaleStart,
} from "@/lib/tauri";
import { InstallProgress } from "./InstallProgress";
import type { Cluster, PhaseEvent, TfvarsConfig } from "@/lib/types";
import { PHASE_DEFS } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StateBadge({ state }: { state: string }) {
  const cls: Record<string, string> = {
    draft: "bg-muted text-muted-foreground",
    installing: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    ready: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    failed: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    destroying: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
    scaling: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
    destroyed: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-medium capitalize",
        cls[state] ?? "bg-muted text-muted-foreground",
      )}
    >
      {state}
    </span>
  );
}

function ageSince(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

const PRICE_MAP: Record<string, number> = {
  "t3.micro": 0.011,
  "t3.small": 0.023,
  "t3.medium": 0.046,
  "t3.large": 0.091,
  "m5.large": 0.096,
  "m5.xlarge": 0.192,
  "m5.2xlarge": 0.384,
  "m5.4xlarge": 0.768,
  "r5.large": 0.126,
  "r5.xlarge": 0.252,
  "r5.2xlarge": 0.504,
  "r5.4xlarge": 1.008,
};
function costPerHour(tf: TfvarsConfig): number {
  const p = (t: string) => PRICE_MAP[t] ?? 0.2;
  return (
    tf.master_count * p(tf.master_instance_type) +
    tf.worker_count * p(tf.worker_instance_type) +
    tf.edge_count * p(tf.edge_instance_type) +
    p(tf.bastion_instance_type) +
    p(tf.ipa_instance_type) +
    p(tf.util_instance_type)
  );
}

// ---------------------------------------------------------------------------
// Destroy confirm dialog
// ---------------------------------------------------------------------------

function DestroyDialog({
  name,
  onCancel,
  onConfirm,
  busy,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const [typed, setTyped] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-xl border border-border shadow-xl p-6 max-w-md w-full mx-4 space-y-4">
        <div className="space-y-1">
          <h3 className="text-[16px] font-semibold text-destructive">
            Destroy cluster?
          </h3>
          <p className="text-[13px] text-muted-foreground">
            This will delete <strong>all AWS resources</strong> for cluster{" "}
            <span className="font-mono font-medium">{name}</span>. Terraform
            destroy is not reversible.
          </p>
        </div>
        <div className="space-y-1.5">
          <label className="text-[12px] text-muted-foreground">
            Type the cluster name to confirm:
          </label>
          <input
            autoFocus
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={name}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-ring font-mono"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={typed !== name || busy}
            onClick={onConfirm}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            {busy ? "Starting destroy…" : "Destroy"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Secrets tab
// ---------------------------------------------------------------------------

const SECRET_KEYS = [
  { key: "PAYWALL_USER", label: "CDP Paywall username" },
  { key: "PAYWALL_PASS", label: "CDP Paywall password" },
  { key: "DS_PASSWORD", label: "DS password" },
  { key: "ADM_PASSWORD", label: "Admin password" },
  { key: "CM_ADMIN_PASSWORD", label: "CM admin password" },
  { key: "DB_ROOT_PASSWORD", label: "DB root password" },
] as const;

function SecretsTab({ cluster }: { cluster: Cluster }) {
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);

  async function reveal(key: string) {
    if (revealed[key]) {
      setRevealed((r) => {
        const n = { ...r };
        delete n[key];
        return n;
      });
      return;
    }
    setLoading((l) => ({ ...l, [key]: true }));
    try {
      const value = await keychainGet(cluster.id, key);
      setRevealed((r) => ({ ...r, [key]: value }));
    } catch {
      /* ignore */
    } finally {
      setLoading((l) => ({ ...l, [key]: false }));
    }
  }

  async function copy(key: string) {
    const value =
      revealed[key] ?? (await keychainGet(cluster.id, key).catch(() => ""));
    await navigator.clipboard.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div className="space-y-1">
      {SECRET_KEYS.map(({ key, label }) => (
        <div
          key={key}
          className="flex items-center gap-3 px-4 py-2.5 rounded-lg hover:bg-muted/30 transition-colors"
        >
          <div className="flex-1 min-w-0">
            <p className="text-[12px] text-muted-foreground">{label}</p>
            <p className="font-mono text-[13px] mt-0.5">
              {revealed[key] ?? "••••••••"}
            </p>
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => reveal(key)}
              className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
              title={revealed[key] ? "Hide" : "Reveal"}
              disabled={loading[key]}
            >
              {revealed[key] ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              onClick={() => copy(key)}
              className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
              title="Copy"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
            {copied === key && (
              <span className="text-[10px] text-green-500 self-center">
                Copied!
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase history tab
// ---------------------------------------------------------------------------

function PhaseHistoryTab({ cluster }: { cluster: Cluster }) {
  const [events, setEvents] = useState<PhaseEvent[]>([]);

  useEffect(() => {
    clusterPhaseEvents(cluster.id)
      .then(setEvents)
      .catch(() => {});
  }, [cluster.id]);

  const phaseLabel = (key: string) =>
    PHASE_DEFS.find((d) => d.key === key)?.label ?? key;

  if (events.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground px-4">
        No phase events recorded.
      </p>
    );
  }

  return (
    <div className="space-y-0.5">
      {events.map((ev) => {
        const durationMs = ev.finished_at
          ? new Date(ev.finished_at).getTime() -
            new Date(ev.started_at).getTime()
          : null;
        const durationStr =
          durationMs !== null
            ? durationMs < 60000
              ? `${(durationMs / 1000).toFixed(0)}s`
              : `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`
            : null;

        return (
          <div
            key={ev.id}
            className="flex items-center gap-3 px-4 py-2 text-[13px]"
          >
            <span
              className={cn(
                "inline-flex rounded-full w-2 h-2 flex-shrink-0",
                ev.status === "success" && "bg-green-500",
                ev.status === "failed" && "bg-destructive",
                ev.status === "running" && "bg-blue-500",
                ev.status === "interrupted" && "bg-yellow-500",
                !["success", "failed", "running", "interrupted"].includes(
                  ev.status,
                ) && "bg-muted-foreground/40",
              )}
            />
            <span className="flex-1 font-medium">{phaseLabel(ev.phase)}</span>
            {durationStr && (
              <span className="text-muted-foreground tabular-nums text-[12px]">
                {durationStr}
              </span>
            )}
            <span className="text-muted-foreground capitalize text-[12px]">
              {ev.status}
            </span>
            {ev.error_summary && (
              <span
                className="text-destructive text-[11px] truncate max-w-[200px]"
                title={ev.error_summary}
              >
                {ev.error_summary}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cost card
// ---------------------------------------------------------------------------

function CostCard({ cluster }: { cluster: Cluster }) {
  if (!cluster.tfvars_json) return null;
  let tf: TfvarsConfig;
  try {
    tf = JSON.parse(cluster.tfvars_json);
  } catch {
    return null;
  }

  const hourly = costPerHour(tf);
  const hrsSince =
    (Date.now() - new Date(cluster.created_at).getTime()) / 3_600_000;
  const totalSoFar = hourly * hrsSince;
  const monthly = hourly * 730;

  return (
    <div className="rounded-lg border border-border/50 p-4 space-y-1 text-[13px]">
      <p className="font-medium">Estimated cost</p>
      <div className="flex justify-between text-muted-foreground">
        <span>Hourly rate</span>
        <span className="tabular-nums">${hourly.toFixed(3)}/hr</span>
      </div>
      <div className="flex justify-between text-muted-foreground">
        <span>Since creation</span>
        <span className="tabular-nums">${totalSoFar.toFixed(2)}</span>
      </div>
      <div className="flex justify-between font-medium border-t border-border/40 pt-1 mt-1">
        <span>Monthly projection</span>
        <span className="tabular-nums">${monthly.toFixed(0)}/mo</span>
      </div>
      <p className="text-[10px] text-muted-foreground/60">
        On-demand pricing, ap-south-1
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scale workers panel (inline, shown below action bar)
// ---------------------------------------------------------------------------

const PRICE_WORKER: Record<string, number> = {
  "r5.4xlarge": 1.008, "r5.2xlarge": 0.504, "r5.xlarge": 0.252,
  "m5.4xlarge": 0.768, "m5.2xlarge": 0.384, "m5.xlarge": 0.192,
  "c5.2xlarge": 0.34,  "c5.xlarge": 0.17,
};

function ScalePanel({
  cluster,
  onStarted,
  onCancel,
}: {
  cluster: Cluster;
  onStarted: (c: Cluster) => void;
  onCancel: () => void;
}) {
  const tf: TfvarsConfig | null = (() => {
    try { return cluster.tfvars_json ? JSON.parse(cluster.tfvars_json) : null; }
    catch { return null; }
  })();

  const currentCount = tf?.worker_count ?? 0;
  const [targetCount, setTargetCount] = useState(currentCount + 1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const addCount = Math.max(0, targetCount - currentCount);
  const workerType = tf?.worker_instance_type ?? "r5.4xlarge";
  const pricePerWorker = PRICE_WORKER[workerType] ?? 0.2;
  const addHourly = addCount * pricePerWorker;
  const addMonthly = addHourly * 730;

  async function handleScale() {
    if (targetCount <= currentCount) {
      setErr(`Target must be greater than current count (${currentCount})`);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await scaleStart(cluster.id, targetCount);
      onStarted(await clusterGet(cluster.id));
    } catch (e: unknown) {
      const msg =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setErr(msg);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-5 space-y-4 max-w-md">
      <div className="space-y-0.5">
        <h3 className="text-[14px] font-semibold">Scale worker nodes</h3>
        <p className="text-[12px] text-muted-foreground">
          Terraform adds the new EC2 instances, then Ansible installs
          prerequisites and CM agents on them automatically.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between text-[13px]">
          <span className="text-muted-foreground">Current workers</span>
          <span className="font-mono font-medium">
            {currentCount} × {workerType}
          </span>
        </div>

        <div className="space-y-1.5">
          <label className="text-[13px] font-medium">New total worker count</label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={currentCount + 1}
              max={currentCount + 20}
              value={targetCount}
              onChange={(e) => setTargetCount(Number(e.target.value))}
              className="flex-1 accent-primary"
            />
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={currentCount + 1}
                value={targetCount}
                onChange={(e) => {
                  const n = Math.max(currentCount + 1, Number(e.target.value));
                  setTargetCount(n);
                }}
                className="w-16 rounded-md border border-border bg-background px-2 py-1.5 text-[13px] outline-none focus:ring-1 focus:ring-ring text-center"
              />
              <span className="text-[12px] text-muted-foreground">nodes</span>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Adding <strong>{addCount}</strong> worker{addCount !== 1 ? "s" : ""}
          </p>
        </div>

        {addCount > 0 && (
          <div className="rounded-lg border border-border/50 divide-y divide-border/30 text-[12px]">
            <div className="flex justify-between px-3 py-1.5 text-muted-foreground">
              <span>Additional hourly cost</span>
              <span className="tabular-nums text-foreground">
                +${addHourly.toFixed(3)}/hr
              </span>
            </div>
            <div className="flex justify-between px-3 py-1.5 font-medium">
              <span>Additional monthly cost</span>
              <span className="tabular-nums">+${addMonthly.toFixed(0)}/mo</span>
            </div>
          </div>
        )}
      </div>

      {err && <p className="text-[12px] text-destructive">{err}</p>}

      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={handleScale}
          disabled={busy || addCount === 0}
        >
          <ChevronsUp className="h-3.5 w-3.5 mr-1.5" />
          {busy ? "Starting scale…" : `Scale to ${targetCount} workers`}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ready / detail view
// ---------------------------------------------------------------------------

type Tab = "overview" | "history" | "secrets" | "templates" | "health";

function ReadyView({
  cluster,
  onClusterChange,
}: {
  cluster: Cluster;
  onClusterChange: (c: Cluster) => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [showDestroy, setShowDestroy] = useState(false);
  const [destroying, setDestroying] = useState(false);
  const [showScale, setShowScale] = useState(false);
  const [cmBusy, setCmBusy] = useState(false);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [sshBusy, setSshBusy] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const tf: TfvarsConfig | null = (() => {
    try {
      return cluster.tfvars_json ? JSON.parse(cluster.tfvars_json) : null;
    } catch {
      return null;
    }
  })();

  const meta: Record<string, string> | null = (() => {
    try {
      return cluster.metadata_json ? JSON.parse(cluster.metadata_json) : null;
    } catch {
      return null;
    }
  })();

  const domain = tf?.private_dns_domain ?? "cdp.prod.internal";
  const bastionIp = meta?.bastion_public_ip ?? meta?.bastion_ip ?? null;

  async function doAction(
    fn: () => Promise<void>,
    setBusy: (b: boolean) => void,
  ) {
    setActionError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e: unknown) {
      const msg =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setActionError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDestroy() {
    setDestroying(true);
    try {
      await destroyStart(cluster.id);
      setShowDestroy(false);
      // ClusterDetail will re-render in the destroying state
      onClusterChange(await clusterGet(cluster.id));
    } catch (e: unknown) {
      const msg =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setActionError(msg);
    }
    setDestroying(false);
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "health", label: "Health" },
    { id: "history", label: "Phase history" },
    { id: "secrets", label: "Secrets" },
    { id: "templates", label: "Templates" },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border/50 flex-shrink-0 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0" />
          <h2 className="text-[16px] font-semibold">{cluster.name}</h2>
          <StateBadge state={cluster.state} />
          <span className="text-[12px] text-muted-foreground">
            {cluster.aws_profile} / {cluster.aws_region}
          </span>
          <span className="text-[12px] text-muted-foreground ml-auto">
            Created {ageSince(cluster.created_at)} ago
          </span>
        </div>

        {/* Quick actions */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            disabled={cmBusy || !bastionIp}
            title={
              !bastionIp
                ? "Bastion IP not yet available (terraform output not captured)"
                : undefined
            }
            onClick={() => doAction(() => openCmUi(cluster.id), setCmBusy)}
          >
            <Globe className="h-3.5 w-3.5 mr-1.5" />
            {cmBusy ? "Opening CM…" : "Open CM UI"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={sshBusy || !bastionIp}
            title={!bastionIp ? "Bastion IP not yet available" : undefined}
            onClick={() =>
              doAction(() => openSshTerminal(cluster.id), setSshBusy)
            }
          >
            <Terminal className="h-3.5 w-3.5 mr-1.5" />
            SSH to bastion
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={tunnelBusy || !bastionIp}
            title={!bastionIp ? "Bastion IP not yet available" : undefined}
            onClick={() =>
              doAction(() => openCmTunnel(cluster.id), setTunnelBusy)
            }
          >
            <Terminal className="h-3.5 w-3.5 mr-1.5" />
            {tunnelBusy ? "Opening tunnel…" : "CM Tunnel"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={copyBusy}
            onClick={async () => {
              setCopyBusy(true);
              try {
                const text = await clusterEnvVars(cluster.id);
                await navigator.clipboard.writeText(text);
              } catch {
                /* ignore */
              } finally {
                setCopyBusy(false);
              }
            }}
          >
            <Clipboard className="h-3.5 w-3.5 mr-1.5" />
            Copy env vars
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              showScale
                ? "border-primary text-primary bg-primary/5"
                : "",
            )}
            onClick={() => setShowScale((s) => !s)}
          >
            <ChevronsUp className="h-3.5 w-3.5 mr-1.5" />
            Scale Workers
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/40 ml-auto"
            onClick={() => setShowDestroy(true)}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            Destroy
          </Button>
        </div>
        {actionError && (
          <p className="text-[12px] text-destructive">{actionError}</p>
        )}
        {showScale && (
          <ScalePanel
            cluster={cluster}
            onStarted={(c) => {
              setShowScale(false);
              onClusterChange(c);
            }}
            onCancel={() => setShowScale(false)}
          />
        )}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 px-6 pt-3 border-b border-border/40 flex-shrink-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "px-3 py-1.5 text-[13px] font-medium rounded-t transition-colors -mb-px border-b-2",
              tab === t.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-6">
        {tab === "overview" && (
          <div className="grid grid-cols-1 gap-6 max-w-2xl">
            {/* Metadata card */}
            <div className="rounded-lg border border-border/50 divide-y divide-border/50 text-[13px]">
              {[
                ["Cluster ID", cluster.id],
                ["Domain", domain],
                ["Util1 host", `util1.${domain}`],
                ["Bastion IP", bastionIp ?? "(available after install)"],
                ["Repo path", cluster.repo_path],
                ["Created", new Date(cluster.created_at).toLocaleString()],
                [
                  "Workers",
                  tf ? `${tf.worker_count} × ${tf.worker_instance_type}` : "—",
                ],
                [
                  "Masters",
                  tf ? `${tf.master_count} × ${tf.master_instance_type}` : "—",
                ],
              ].map(([label, value]) => (
                <div key={label} className="flex px-4 py-2.5 gap-4">
                  <span className="w-28 text-muted-foreground flex-shrink-0">
                    {label}
                  </span>
                  <span className="font-mono text-[12px] break-all">
                    {value}
                  </span>
                </div>
              ))}
            </div>

            <CostCard cluster={cluster} />
          </div>
        )}
        {tab === "health" && (
          <div className="max-w-4xl">
            <ClusterHealthPanel clusterId={cluster.id} />
          </div>
        )}
        {tab === "history" && <PhaseHistoryTab cluster={cluster} />}
        {tab === "secrets" && <SecretsTab cluster={cluster} />}
        {tab === "templates" && (
          <div className="p-4">
            <TemplatesPanel clusterId={cluster.id} clusterState={cluster.state} />
          </div>
        )}
      </div>

      {/* Destroy dialog */}
      {showDestroy && (
        <DestroyDialog
          name={cluster.name}
          onCancel={() => setShowDestroy(false)}
          onConfirm={confirmDestroy}
          busy={destroying}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ClusterDetail — top-level router
// ---------------------------------------------------------------------------

export default function ClusterDetail() {
  const { id } = useParams<{ id: string }>();
  const [cluster, setCluster] = useState<Cluster | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setCluster(await clusterGet(id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div className="p-8 text-[13px] text-destructive">
        Failed to load cluster: {error}
      </div>
    );
  }
  if (!cluster) {
    return (
      <div className="p-8 text-[13px] text-muted-foreground">Loading…</div>
    );
  }

  const { state } = cluster;

  if (
    state === "installing" ||
    state === "destroying" ||
    state === "scaling" ||
    state === "failed"
  ) {
    return (
      <div className="flex flex-col h-full">
        <InstallProgress cluster={cluster} onClusterChange={setCluster} />
      </div>
    );
  }

  if (state === "destroyed") {
    return (
      <div className="flex items-center justify-center h-full text-[13px] text-muted-foreground">
        <div className="text-center space-y-1">
          <Server className="h-8 w-8 mx-auto opacity-30" />
          <p className="font-medium">{cluster.name}</p>
          <p>
            Destroyed{" "}
            {cluster.destroyed_at
              ? new Date(cluster.destroyed_at).toLocaleString()
              : ""}
          </p>
        </div>
      </div>
    );
  }

  return <ReadyView cluster={cluster} onClusterChange={setCluster} />;
}
