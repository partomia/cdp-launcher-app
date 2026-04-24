import { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { CheckCircle, Server } from "lucide-react";
import { clusterGet } from "@/lib/tauri";
import { InstallProgress } from "./InstallProgress";
import type { Cluster } from "@/lib/types";

function ReadyView({ cluster }: { cluster: Cluster }) {
  return (
    <div className="p-8 max-w-xl space-y-6">
      <div className="flex items-center gap-3">
        <CheckCircle className="h-6 w-6 text-green-500" />
        <div>
          <h2 className="text-[16px] font-semibold">{cluster.name}</h2>
          <p className="text-[12px] text-muted-foreground">
            Ready &mdash; {cluster.aws_profile} / {cluster.aws_region}
          </p>
        </div>
      </div>
      <div className="rounded-lg border border-border/50 divide-y divide-border/50 text-[13px]">
        {[
          ["Cluster ID", cluster.id],
          ["Profile", cluster.aws_profile],
          ["Region", cluster.aws_region],
          ["Repo", cluster.repo_path],
          ["Created", new Date(cluster.created_at).toLocaleString()],
        ].map(([label, value]) => (
          <div key={label} className="flex px-4 py-2.5 gap-4">
            <span className="w-24 text-muted-foreground flex-shrink-0">{label}</span>
            <span className="font-mono text-[12px] break-all">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DestroyedView({ cluster }: { cluster: Cluster }) {
  return (
    <div className="flex items-center justify-center h-full text-[13px] text-muted-foreground">
      <div className="text-center space-y-1">
        <Server className="h-8 w-8 mx-auto opacity-30" />
        <p className="font-medium">{cluster.name}</p>
        <p>
          Destroyed {cluster.destroyed_at
            ? new Date(cluster.destroyed_at).toLocaleString()
            : ""}
        </p>
      </div>
    </div>
  );
}

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

  useEffect(() => { load(); }, [load]);

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

  if (state === "installing" || state === "destroying" || state === "failed") {
    return (
      <div className="flex flex-col h-full">
        <InstallProgress cluster={cluster} onClusterChange={setCluster} />
      </div>
    );
  }

  if (state === "destroyed") {
    return <DestroyedView cluster={cluster} />;
  }

  // ready (or draft)
  return <ReadyView cluster={cluster} />;
}
