import { useState } from "react";
import {
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  MinusCircle,
  HelpCircle,
  Shield,
  ShieldOff,
  Key,
  Users,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { clusterHealthFetch } from "@/lib/tauri";
import type {
  ClusterHealth,
  CmHostSummary,
  CmServiceSummary,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Health indicator
// ---------------------------------------------------------------------------

function HealthDot({ status }: { status: string }) {
  const map: Record<string, { cls: string; icon: React.ReactNode }> = {
    GOOD: {
      cls: "text-green-500",
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    },
    CONCERNING: {
      cls: "text-yellow-500",
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
    },
    BAD: {
      cls: "text-red-500",
      icon: <XCircle className="h-3.5 w-3.5" />,
    },
    DISABLED: {
      cls: "text-muted-foreground",
      icon: <MinusCircle className="h-3.5 w-3.5" />,
    },
  };
  const entry = map[status] ?? {
    cls: "text-muted-foreground",
    icon: <HelpCircle className="h-3.5 w-3.5" />,
  };
  return <span className={cn("inline-flex", entry.cls)}>{entry.icon}</span>;
}

function HealthBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    GOOD: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    CONCERNING:
      "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300",
    BAD: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    DISABLED: "bg-muted text-muted-foreground",
    STARTED: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    STOPPED: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    STOPPING:
      "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
    STARTING:
      "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  };
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium",
        map[status] ?? "bg-muted text-muted-foreground",
      )}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Service friendly names
// ---------------------------------------------------------------------------

const SERVICE_LABELS: Record<string, string> = {
  HDFS: "HDFS",
  YARN: "YARN",
  HIVE: "Hive",
  HIVE_ON_TEZ: "Hive on Tez",
  RANGER: "Ranger",
  ATLAS: "Atlas",
  KAFKA: "Kafka",
  SPARK_ON_YARN: "Spark",
  SPARK3_ON_YARN: "Spark 3",
  HUE: "Hue",
  OOZIE: "Oozie",
  ZOOKEEPER: "ZooKeeper",
  KNOX: "Knox",
  SCHEMAREGISTRY: "Schema Registry",
  STREAMS_MESSAGING_MANAGER: "SMM",
  YARN_QUEUE_MANAGER: "Queue Manager",
  SOLR: "Solr",
  IMPALA: "Impala",
  KUDU: "Kudu",
  NIFI: "NiFi",
  FLINK: "Flink",
};

function serviceLabel(s: CmServiceSummary): string {
  return (
    s.display_name ??
    SERVICE_LABELS[s.service_type] ??
    s.service_type
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtMemory(bytes: number | null): string {
  if (!bytes) return "—";
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(0)} GB`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Role badge
// ---------------------------------------------------------------------------

const ROLE_COLORS: Record<string, string> = {
  Util: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  Master: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  Worker: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  Edge: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  IPA: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  Bastion: "bg-muted text-muted-foreground",
};

function RoleBadge({ role }: { role: string | null }) {
  if (!role) return <span className="text-muted-foreground text-[11px]">—</span>;
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium",
        ROLE_COLORS[role] ?? "bg-muted text-muted-foreground",
      )}
    >
      {role}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Hosts table
// ---------------------------------------------------------------------------

function HostsTable({ hosts }: { hosts: CmHostSummary[] }) {
  if (hosts.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground px-1">No hosts returned.</p>
    );
  }
  return (
    <div className="rounded-lg border border-border/50 overflow-hidden">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-border/40 bg-muted/30">
            <th className="text-left px-3 py-2 text-muted-foreground font-medium">Health</th>
            <th className="text-left px-3 py-2 text-muted-foreground font-medium">Hostname</th>
            <th className="text-left px-3 py-2 text-muted-foreground font-medium">Role</th>
            <th className="text-left px-3 py-2 text-muted-foreground font-medium">IP</th>
            <th className="text-right px-3 py-2 text-muted-foreground font-medium">Cores</th>
            <th className="text-right px-3 py-2 text-muted-foreground font-medium">Memory</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/30">
          {hosts.map((h) => (
            <tr key={h.hostname} className="hover:bg-muted/20 transition-colors">
              <td className="px-3 py-2">
                <HealthDot status={h.health_summary} />
              </td>
              <td className="px-3 py-2 font-mono text-[11px] max-w-[220px] truncate" title={h.hostname}>
                {h.hostname.split(".")[0]}
                <span className="text-muted-foreground/60">
                  .{h.hostname.split(".").slice(1).join(".")}
                </span>
              </td>
              <td className="px-3 py-2">
                <RoleBadge role={h.node_role} />
              </td>
              <td className="px-3 py-2 font-mono text-muted-foreground">
                {h.ip_address || "—"}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {h.num_cores ?? "—"}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {fmtMemory(h.total_phys_mem_bytes)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Services grid
// ---------------------------------------------------------------------------

function ServicesGrid({ services }: { services: CmServiceSummary[] }) {
  if (services.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground px-1">No services found.</p>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
      {services.map((s) => (
        <div
          key={s.name}
          className="rounded-lg border border-border/50 px-3 py-2.5 space-y-1.5 hover:bg-muted/20 transition-colors"
        >
          <div className="flex items-center justify-between gap-1">
            <span className="text-[13px] font-medium truncate">
              {serviceLabel(s)}
            </span>
            <HealthDot status={s.health_summary} />
          </div>
          <HealthBadge status={s.service_state} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Security section
// ---------------------------------------------------------------------------

function SecuritySection({ health }: { health: ClusterHealth }) {
  const { kerberos, ldap_enabled, ldap_url, ldap_bind_dn, auto_tls_enabled } =
    health;

  const rows: { icon: React.ReactNode; label: string; value: React.ReactNode }[] =
    [
      {
        icon: auto_tls_enabled ? (
          <Shield className="h-4 w-4 text-green-500" />
        ) : (
          <ShieldOff className="h-4 w-4 text-muted-foreground" />
        ),
        label: "Auto-TLS",
        value: (
          <HealthBadge status={auto_tls_enabled ? "STARTED" : "STOPPED"} />
        ),
      },
      {
        icon: <Key className="h-4 w-4 text-muted-foreground" />,
        label: "Kerberos",
        value: kerberos.kerberos_enabled ? (
          <div className="space-y-0.5">
            <HealthBadge status="STARTED" />
            {kerberos.realm && (
              <p className="font-mono text-[11px] text-muted-foreground">
                {kerberos.realm}
              </p>
            )}
            {kerberos.kdc_host && (
              <p className="font-mono text-[11px] text-muted-foreground">
                KDC: {kerberos.kdc_host}
              </p>
            )}
            {kerberos.kdc_type && (
              <p className="text-[11px] text-muted-foreground">
                {kerberos.kdc_type}
              </p>
            )}
          </div>
        ) : (
          <HealthBadge status="DISABLED" />
        ),
      },
      {
        icon: <Users className="h-4 w-4 text-muted-foreground" />,
        label: "LDAP / AD",
        value: ldap_enabled ? (
          <div className="space-y-0.5">
            <HealthBadge status="STARTED" />
            {ldap_url && (
              <p className="font-mono text-[11px] text-muted-foreground break-all">
                {ldap_url}
              </p>
            )}
            {ldap_bind_dn && (
              <p className="font-mono text-[11px] text-muted-foreground break-all">
                {ldap_bind_dn}
              </p>
            )}
          </div>
        ) : (
          <HealthBadge status="DISABLED" />
        ),
      },
      {
        icon: <Lock className="h-4 w-4 text-muted-foreground" />,
        label: "CM version",
        value: (
          <span className="font-mono text-[12px] text-muted-foreground">
            {health.cm_version ?? "—"}
          </span>
        ),
      },
    ];

  return (
    <div className="rounded-lg border border-border/50 divide-y divide-border/40">
      {rows.map(({ icon, label, value }) => (
        <div key={label} className="flex items-start gap-3 px-4 py-3">
          <div className="mt-0.5 flex-shrink-0">{icon}</div>
          <div className="w-28 flex-shrink-0 text-[12px] text-muted-foreground pt-0.5">
            {label}
          </div>
          <div className="flex-1">{value}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function ClusterHealthPanel({ clusterId }: { clusterId: string }) {
  const [health, setHealth] = useState<ClusterHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchHealth() {
    setLoading(true);
    setError(null);
    try {
      const result = await clusterHealthFetch(clusterId);
      setHealth(result);
    } catch (e: unknown) {
      const msg =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  const goodCount = health?.hosts.filter((h) => h.health_summary === "GOOD").length ?? 0;
  const badCount = health?.hosts.filter(
    (h) => h.health_summary === "BAD" || h.health_summary === "CONCERNING",
  ).length ?? 0;
  const serviceGood = health?.services.filter((s) => s.health_summary === "GOOD").length ?? 0;
  const serviceBad = health?.services.filter(
    (s) => s.health_summary === "BAD" || s.health_summary === "CONCERNING",
  ).length ?? 0;

  return (
    <div className="space-y-6">
      {/* Header / fetch bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <Button
          size="sm"
          variant="outline"
          onClick={fetchHealth}
          disabled={loading}
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5 mr-1.5", loading && "animate-spin")}
          />
          {loading ? "Fetching via SSH tunnel…" : health ? "Refresh" : "Fetch Health"}
        </Button>

        {health && !loading && (
          <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
            <span>
              Hosts:{" "}
              <span className="text-green-500 font-medium">{goodCount} healthy</span>
              {badCount > 0 && (
                <span className="text-red-500 font-medium ml-1">
                  {badCount} unhealthy
                </span>
              )}
            </span>
            <span>·</span>
            <span>
              Services:{" "}
              <span className="text-green-500 font-medium">{serviceGood} healthy</span>
              {serviceBad > 0 && (
                <span className="text-red-500 font-medium ml-1">
                  {serviceBad} unhealthy
                </span>
              )}
            </span>
            <span>·</span>
            <span>Last fetched {fmtTime(health.fetched_at)}</span>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-[12px] text-destructive space-y-1">
          <p className="font-medium">Health fetch failed</p>
          <p className="font-mono whitespace-pre-wrap">{error}</p>
        </div>
      )}

      {!health && !loading && !error && (
        <p className="text-[13px] text-muted-foreground">
          Click <strong>Fetch Health</strong> to open an SSH tunnel to CM and retrieve live health
          data. Requires a running cluster with bastion access.
        </p>
      )}

      {health && (
        <>
          {/* Security */}
          <div className="space-y-2">
            <h3 className="text-[13px] font-semibold text-muted-foreground uppercase tracking-wide">
              Security
            </h3>
            <SecuritySection health={health} />
          </div>

          {/* Services */}
          <div className="space-y-2">
            <h3 className="text-[13px] font-semibold text-muted-foreground uppercase tracking-wide">
              Services ({health.services.length})
            </h3>
            <ServicesGrid services={health.services} />
          </div>

          {/* Hosts */}
          <div className="space-y-2">
            <h3 className="text-[13px] font-semibold text-muted-foreground uppercase tracking-wide">
              Hosts ({health.hosts.length})
            </h3>
            <HostsTable hosts={health.hosts} />
          </div>
        </>
      )}
    </div>
  );
}
