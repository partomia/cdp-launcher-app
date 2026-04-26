import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { PlusCircle, RefreshCw, Trash2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { clusterList, clusterDeleteMetadata, destroyStart } from "@/lib/tauri";
import type { Cluster, TfvarsConfig } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ageSince(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// Rough on-demand pricing for ap-south-1 (USD/hr)
const PRICE_MAP: Record<string, number> = {
  "t3.micro": 0.011,
  "t3.small": 0.023,
  "t3.medium": 0.046,
  "t3.large": 0.091,
  "m5.large": 0.096,
  "m5.xlarge": 0.192,
  "m5.2xlarge": 0.384,
  "m5.4xlarge": 0.768,
  "m5.8xlarge": 1.536,
  "r5.large": 0.126,
  "r5.xlarge": 0.252,
  "r5.2xlarge": 0.504,
  "r5.4xlarge": 1.008,
  "r5.8xlarge": 2.016,
  "c5.large": 0.085,
  "c5.xlarge": 0.17,
  "c5.2xlarge": 0.34,
};

function costPerHour(tfvars: TfvarsConfig): number {
  const p = (t: string) => PRICE_MAP[t] ?? 0.2;
  return (
    tfvars.master_count * p(tfvars.master_instance_type) +
    tfvars.worker_count * p(tfvars.worker_instance_type) +
    tfvars.edge_count * p(tfvars.edge_instance_type) +
    p(tfvars.bastion_instance_type) +
    p(tfvars.ipa_instance_type) +
    p(tfvars.util_instance_type)
  );
}

function monthlyCost(cluster: Cluster): string {
  if (!cluster.tfvars_json) return "—";
  try {
    const tf: TfvarsConfig = JSON.parse(cluster.tfvars_json);
    const monthly = costPerHour(tf) * 730;
    return `$${monthly.toFixed(0)}/mo`;
  } catch {
    return "—";
  }
}

function workerCount(cluster: Cluster): string {
  if (!cluster.tfvars_json) return "—";
  try {
    const tf: TfvarsConfig = JSON.parse(cluster.tfvars_json);
    return String(tf.worker_count);
  } catch {
    return "—";
  }
}

function StateBadge({ state }: { state: string }) {
  const cls: Record<string, string> = {
    draft: "bg-muted text-muted-foreground",
    installing: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    ready: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    failed: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    destroying:
      "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
    destroyed: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
        cls[state] ?? "bg-muted text-muted-foreground",
      )}
    >
      {state}
    </span>
  );
}

function ProviderBadge({ provider }: { provider: string }) {
  const labels: Record<string, string> = {
    aws: "AWS",
    gcp: "GCP",
    azure: "Azure",
    onprem: "On-Prem",
  };
  const colors: Record<string, string> = {
    aws: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
    gcp: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    azure: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
    onprem: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        colors[provider] ?? "bg-muted text-muted-foreground",
      )}
    >
      {labels[provider] ?? provider}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const navigate = useNavigate();
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [destroying, setDestroying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setClusters(await clusterList());
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh when installs/destroys complete
  useEffect(() => {
    const subs = [
      listen("install-complete", load),
      listen("destroy-complete", load),
    ];
    return () => {
      subs.forEach((p) => p.then((fn) => fn()));
    };
  }, [load]);

  async function handleDestroy(cluster: Cluster) {
    if (destroying) return;
    setDestroying(cluster.id);
    try {
      await destroyStart(cluster.id);
      navigate(`/cluster/${cluster.id}`);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
      setDestroying(null);
    }
  }

  async function handleDelete(cluster: Cluster) {
    if (!confirm(`Delete record for "${cluster.name}"? This only removes the database entry — no AWS resources are affected.`)) return;
    setDeleting(cluster.id);
    try {
      await clusterDeleteMetadata(cluster.id);
      await load();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[13px] text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (clusters.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-center max-w-sm">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <PlusCircle className="h-7 w-7 text-muted-foreground" />
          </div>
          <h2 className="text-[18px] font-semibold mb-2">No clusters yet</h2>
          <p className="text-[14px] text-muted-foreground mb-6">
            Click <strong>New Install</strong> to create your first CDP cluster.
          </p>
          <Button asChild>
            <Link to="/install">
              <PlusCircle className="h-4 w-4" />
              New Install
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-medium text-muted-foreground">
          {clusters.length} cluster{clusters.length !== 1 ? "s" : ""}
        </h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
          <Button size="sm" asChild>
            <Link to="/install">
              <PlusCircle className="h-3.5 w-3.5" />
              New Install
            </Link>
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border/50 overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border/50 bg-muted/30">
              {[
                "Name",
                "State",
                "Provider",
                "Region",
                "Workers",
                "Age",
                "Est. Cost",
                "",
              ].map((h) => (
                <th
                  key={h}
                  className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30">
            {clusters.map((c) => (
              <tr key={c.id} className="hover:bg-muted/20 transition-colors">
                <td className="px-4 py-3 font-medium">{c.name}</td>
                <td className="px-4 py-3">
                  <StateBadge state={c.state} />
                </td>
                <td className="px-4 py-3">
                  <ProviderBadge provider={c.provider ?? "aws"} />
                </td>
                <td className="px-4 py-3 text-muted-foreground font-mono text-[12px]">
                  {c.aws_region}
                </td>
                <td className="px-4 py-3 text-muted-foreground tabular-nums">
                  {workerCount(c)}
                </td>
                <td className="px-4 py-3 text-muted-foreground tabular-nums">
                  {ageSince(c.created_at)}
                </td>
                <td className="px-4 py-3 text-muted-foreground tabular-nums">
                  {monthlyCost(c)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1 justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-[12px]"
                      onClick={() => navigate(`/cluster/${c.id}`)}
                    >
                      <ExternalLink className="h-3 w-3 mr-1" />
                      Open
                    </Button>
                    {c.state === "ready" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[12px] text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => handleDestroy(c)}
                        disabled={destroying === c.id}
                      >
                        <Trash2 className="h-3 w-3 mr-1" />
                        {destroying === c.id ? "Starting…" : "Destroy"}
                      </Button>
                    )}
                    {(c.state === "destroyed" || c.state === "failed" || c.state === "draft") && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[12px] text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        onClick={() => handleDelete(c)}
                        disabled={deleting === c.id}
                        title="Remove this record from the database"
                      >
                        <Trash2 className="h-3 w-3 mr-1" />
                        {deleting === c.id ? "Deleting…" : "Delete"}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
