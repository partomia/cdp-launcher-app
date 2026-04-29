import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Loader2, XCircle, CheckCircle, StopCircle, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  installCancel,
  installStart,
  destroyStart,
  scaleStart,
  clusterGet,
  clusterPhaseEvents,
  clusterValidateRepoPath,
  clusterUpdateRepoPath,
  settingsGet,
} from "@/lib/tauri";
import { PhaseTracker } from "@/components/PhaseTracker";
import { LogPane } from "@/components/LogPane";
import { ErrorHintBanner } from "@/components/ErrorHintBanner";
import type { Cluster, ErrorHint } from "@/lib/types";

interface Props {
  cluster: Cluster;
  onClusterChange: (c: Cluster) => void;
}

function StateBadge({ state }: { state: string }) {
  const variants: Record<string, string> = {
    installing: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    destroying: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
    scaling: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
    failed: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    ready: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    destroyed: "bg-muted text-muted-foreground",
    draft: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium capitalize",
        variants[state] ?? "bg-muted text-muted-foreground",
      )}
    >
      {state}
    </span>
  );
}

function elapsedSince(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

function RepoPathRepair({
  cluster,
  onClusterChange,
}: {
  cluster: Cluster;
  onClusterChange: (c: Cluster) => void;
}) {
  const [repoPath, setRepoPath] = useState(cluster.repo_path);
  const [defaultRepoPath, setDefaultRepoPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    setRepoPath(cluster.repo_path);
  }, [cluster.repo_path]);

  useEffect(() => {
    settingsGet()
      .then((settings) => setDefaultRepoPath(settings.default_repo_path ?? ""))
      .catch(() => {});
  }, []);

  async function handleValidate() {
    setBusy(true);
    try {
      const result = await clusterValidateRepoPath(repoPath.trim());
      setMsg({ text: result.message, ok: result.ok });
    } catch (e: unknown) {
      setMsg({
        text: e instanceof Error ? e.message : String(e),
        ok: false,
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    setBusy(true);
    try {
      const updated = await clusterUpdateRepoPath(cluster.id, repoPath.trim());
      onClusterChange(updated);
      setMsg({ text: "Installer repo path updated for this cluster.", ok: true });
    } catch (e: unknown) {
      setMsg({
        text: e instanceof Error ? e.message : String(e),
        ok: false,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-4 mt-4 rounded-lg border border-amber-500/30 bg-amber-50/40 dark:bg-amber-950/10 p-4 space-y-3 flex-shrink-0">
      <div className="space-y-1">
        <h3 className="text-[13px] font-semibold">Installer repo path</h3>
        <p className="text-[12px] text-muted-foreground">
          This cluster uses the path saved at creation time. If it points to an old checkout,
          fix it here, then resume the install.
        </p>
      </div>
      <input
        type="text"
        value={repoPath}
        onChange={(e) => setRepoPath(e.target.value)}
        placeholder="/Users/you/IdeaProjects/CDP7.3.2-Installation/cdp-732-automation"
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-ring font-mono"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={handleValidate} disabled={busy}>
          {busy ? "Checking…" : "Validate path"}
        </Button>
        <Button size="sm" onClick={handleSave} disabled={busy || !repoPath.trim()}>
          {busy ? "Saving…" : "Save path"}
        </Button>
        {defaultRepoPath && defaultRepoPath !== repoPath && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRepoPath(defaultRepoPath)}
            disabled={busy}
          >
            Use saved default
          </Button>
        )}
      </div>
      {defaultRepoPath && (
        <p className="text-[11px] text-muted-foreground font-mono break-all">
          Default: {defaultRepoPath}
        </p>
      )}
      {msg && (
        <p className={cn("text-[12px]", msg.ok ? "text-green-600 dark:text-green-400" : "text-destructive")}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

export function InstallProgress({ cluster, onClusterChange }: Props) {
  const [selectedPhase, setSelectedPhase] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [retryingDestroy, setRetryingDestroy] = useState(false);
  const [resumingScale, setResumingScale] = useState(false);
  const [phaseEvents, setPhaseEvents] = useState<import("@/lib/types").PhaseEvent[]>([]);
  const [elapsed, setElapsed] = useState(() =>
    elapsedSince(cluster.created_at),
  );
  const [activeHint, setActiveHint] = useState<ErrorHint | null>(null);

  const isActive =
    cluster.state === "installing" ||
    cluster.state === "destroying" ||
    cluster.state === "scaling";

  // Tick elapsed time while active
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(
      () => setElapsed(elapsedSince(cluster.created_at)),
      1000,
    );
    return () => clearInterval(id);
  }, [isActive, cluster.created_at]);

  // Load phase events so we can detect destroy failures
  useEffect(() => {
    clusterPhaseEvents(cluster.id)
      .then(setPhaseEvents)
      .catch(() => {});
  }, [cluster.id, cluster.state]);

  // True when the most recent phase event is a scale_ phase
  const isScaleFailure = (() => {
    if (phaseEvents.length === 0) return false;
    const sorted = [...phaseEvents].sort(
      (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
    );
    return sorted[0].phase.startsWith("scale_");
  })();

  // True only when the most recent phase event is the destroy phase.
  // Using .some() would incorrectly match old destroy events on a cluster
  // that has since been resumed for install.
  const isDestroyFailure = (() => {
    if (phaseEvents.length === 0) return false;
    const sorted = [...phaseEvents].sort(
      (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
    );
    return sorted[0].phase === "make_tf_destroy";
  })();

  async function handleResumeScale() {
    setResumingScale(true);
    try {
      await scaleStart(cluster.id, 0); // 0 = resume, keep existing target count
      onClusterChange(await clusterGet(cluster.id));
    } catch {}
    setResumingScale(false);
  }

  // Refresh cluster record when install or destroy finishes
  useEffect(() => {
    const subs = [
      listen("scale-complete", async () => {
        try {
          onClusterChange(await clusterGet(cluster.id));
        } catch {}
      }),
      listen("install-complete", async () => {
        try {
          onClusterChange(await clusterGet(cluster.id));
        } catch {}
      }),
      listen("destroy-complete", async () => {
        try {
          onClusterChange(await clusterGet(cluster.id));
        } catch {}
      }),
      listen<{ cluster_id: string; hint: ErrorHint }>("error-hint", (event) => {
        if (event.payload.cluster_id === cluster.id) {
          setActiveHint(event.payload.hint);
        }
      }),
    ];
    return () => {
      subs.forEach((p) => p.then((fn) => fn()));
    };
  }, [cluster.id, onClusterChange]);

  async function handleCancel() {
    setCancelling(true);
    try {
      await installCancel(cluster.id);
    } catch {}
    setCancelling(false);
  }

  async function handleResume() {
    setResuming(true);
    try {
      await installStart(cluster.id);
      onClusterChange(await clusterGet(cluster.id));
    } catch {}
    setResuming(false);
  }

  async function handleRetryDestroy() {
    setRetryingDestroy(true);
    try {
      await destroyStart(cluster.id);
      onClusterChange(await clusterGet(cluster.id));
    } catch {}
    setRetryingDestroy(false);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border/50 flex-shrink-0">
        {isActive && (
          <Loader2 className="h-4 w-4 text-blue-500 animate-spin flex-shrink-0" />
        )}
        {cluster.state === "failed" && (
          <XCircle className="h-4 w-4 text-destructive flex-shrink-0" />
        )}
        {cluster.state === "ready" && (
          <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0" />
        )}

        <h2 className="text-[16px] font-semibold">{cluster.name}</h2>
        <StateBadge state={cluster.state} />
        <span className="text-[12px] text-muted-foreground tabular-nums">
          {elapsed}
        </span>

        <div className="ml-auto flex gap-2">
          {(cluster.state === "failed" || cluster.state === "installing") &&
            !isDestroyFailure && !isScaleFailure && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleResume}
              disabled={resuming}
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
              {resuming ? "Starting…" : "Resume install"}
            </Button>
          )}
          {cluster.state === "failed" && isScaleFailure && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleResumeScale}
              disabled={resumingScale}
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
              {resumingScale ? "Starting…" : "Resume scale"}
            </Button>
          )}
          {cluster.state === "failed" && isDestroyFailure && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRetryDestroy}
              disabled={retryingDestroy}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              {retryingDestroy ? "Starting…" : "Retry destroy"}
            </Button>
          )}
          {isActive && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCancel}
              disabled={cancelling}
            >
              <StopCircle className="h-3.5 w-3.5 mr-1.5" />
              {cancelling ? "Cancelling…" : "Cancel"}
            </Button>
          )}
        </div>
      </div>

      {/* Error hint banner */}
      {activeHint && (
        <div className="px-4 py-2 flex-shrink-0">
          <ErrorHintBanner
            clusterId={cluster.id}
            hint={activeHint}
            onDismiss={() => setActiveHint(null)}
          />
        </div>
      )}

      {cluster.state === "failed" && !isDestroyFailure && (
        <RepoPathRepair cluster={cluster} onClusterChange={onClusterChange} />
      )}

      {/* Body: phase tracker + log pane */}
      <div className="flex flex-1 min-h-0">
        {/* Left: phases */}
        <div className="w-56 flex-shrink-0 border-r border-border/50 overflow-y-auto py-2 px-2">
          <PhaseTracker
            clusterId={cluster.id}
            isActive={isActive}
            selectedPhase={selectedPhase}
            onSelectPhase={setSelectedPhase}
          />
        </div>

        {/* Right: log pane */}
        <div className="flex-1 min-w-0 p-3">
          <LogPane
            clusterId={cluster.id}
            phase={selectedPhase}
            isActive={isActive}
          />
        </div>
      </div>
    </div>
  );
}
