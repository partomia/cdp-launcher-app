import { useCallback, useEffect, useState } from "react";
import {
  Camera,
  Trash2,
  Download,
  Play,
  Pencil,
  Check,
  X,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  templateCapture,
  templateList,
  templateDelete,
  templateRename,
  templateGetJson,
  templateApply,
} from "@/lib/tauri";
import type { ClusterTemplate } from "@/lib/types";

interface Props {
  clusterId: string;
  clusterState: string;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function ServiceBadges({ services }: { services: string }) {
  const list = services.split(",").filter(Boolean);
  const shown = list.slice(0, 6);
  const rest = list.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {shown.map((s) => (
        <span
          key={s}
          className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground"
        >
          {s}
        </span>
      ))}
      {rest > 0 && (
        <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">
          +{rest} more
        </span>
      )}
    </div>
  );
}

export function TemplatesPanel({ clusterId, clusterState }: Props) {
  const [templates, setTemplates] = useState<ClusterTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [showCapture, setShowCapture] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isReady = clusterState === "ready";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTemplates(await templateList(clusterId));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [clusterId]);

  useEffect(() => { load(); }, [load]);

  async function handleCapture() {
    if (!newLabel.trim()) return;
    setCapturing(true);
    setError(null);
    try {
      const t = await templateCapture(clusterId, newLabel.trim());
      setTemplates((prev) => [t, ...prev]);
      setNewLabel("");
      setShowCapture(false);
    } catch (e) {
      setError(`Capture failed: ${e}`);
    } finally {
      setCapturing(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await templateDelete(id);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      setError(`Delete failed: ${e}`);
    } finally {
      setConfirmDeleteId(null);
    }
  }

  async function handleRename(id: string) {
    if (!editLabel.trim()) return;
    try {
      await templateRename(id, editLabel.trim());
      setTemplates((prev) =>
        prev.map((t) => (t.id === id ? { ...t, label: editLabel.trim() } : t)),
      );
    } catch (e) {
      setError(`Rename failed: ${e}`);
    } finally {
      setEditingId(null);
    }
  }

  async function handleDownload(t: ClusterTemplate) {
    try {
      const json = await templateGetJson(t.id);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${t.label.replace(/\s+/g, "-")}-${t.captured_at.slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(`Download failed: ${e}`);
    }
  }

  async function handleApply(id: string) {
    setApplyingId(id);
    setError(null);
    try {
      await templateApply(clusterId, id);
    } catch (e) {
      setError(`Apply failed: ${e}`);
    } finally {
      setApplyingId(null);
    }
  }

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] text-muted-foreground">
            Snapshots of the CM cluster configuration — services, roles, security
            settings. Use to rebuild or clone environments.
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
          {isReady && (
            <Button
              size="sm"
              variant={showCapture ? "secondary" : "outline"}
              onClick={() => setShowCapture((v) => !v)}
            >
              {showCapture ? (
                <ChevronDown className="h-3.5 w-3.5 mr-1.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 mr-1.5" />
              )}
              <Camera className="h-3.5 w-3.5 mr-1.5" />
              Capture snapshot
            </Button>
          )}
        </div>
      </div>

      {/* Capture form */}
      {showCapture && (
        <div className="flex gap-2 p-3 rounded-lg border border-border/60 bg-muted/30">
          <input
            className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="Label, e.g. 'v1.0 baseline' or 'pre-upgrade'"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCapture()}
            autoFocus
          />
          <Button size="sm" onClick={handleCapture} disabled={capturing || !newLabel.trim()}>
            {capturing ? "Capturing…" : "Capture"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setShowCapture(false); setNewLabel(""); }}
          >
            Cancel
          </Button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-[12px] text-destructive flex items-center justify-between">
          {error}
          <button onClick={() => setError(null)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Template list */}
      {templates.length === 0 && !loading && (
        <div className="text-center py-8 text-[13px] text-muted-foreground">
          No snapshots yet.{isReady ? ' Click "Capture snapshot" to create one.' : ""}
        </div>
      )}

      <div className="space-y-2">
        {templates.map((t) => (
          <div
            key={t.id}
            className="rounded-lg border border-border/60 bg-card p-3 space-y-1"
          >
            {/* Label row */}
            <div className="flex items-center gap-2">
              {editingId === t.id ? (
                <>
                  <input
                    className="flex-1 rounded border border-input bg-background px-2 py-0.5 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring"
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRename(t.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    autoFocus
                  />
                  <button onClick={() => handleRename(t.id)} className="text-green-500 hover:text-green-600">
                    <Check className="h-4 w-4" />
                  </button>
                  <button onClick={() => setEditingId(null)} className="text-muted-foreground hover:text-foreground">
                    <X className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <>
                  <span className="font-medium text-[13px] flex-1">{t.label}</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {formatDate(t.captured_at)}
                  </span>
                  <button
                    onClick={() => { setEditingId(t.id); setEditLabel(t.label); }}
                    className="text-muted-foreground hover:text-foreground"
                    title="Rename"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>

            {/* Services */}
            <ServiceBadges services={t.services} />

            {/* CM cluster name */}
            <p className="text-[11px] text-muted-foreground">
              CM cluster: <span className="font-mono">{t.cm_cluster_name}</span>
            </p>

            {/* Action row */}
            {confirmDeleteId === t.id ? (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-[12px] text-destructive flex-1">Delete this snapshot?</span>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => handleDelete(t.id)}
                >
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteId(null)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex gap-1.5 pt-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[12px]"
                  onClick={() => handleDownload(t)}
                  title="Download as JSON"
                >
                  <Download className="h-3.5 w-3.5 mr-1" />
                  Export
                </Button>
                {isReady && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[12px] text-violet-600 hover:text-violet-700"
                    onClick={() => handleApply(t.id)}
                    disabled={applyingId === t.id}
                    title="Apply to CM (imports as new cluster)"
                  >
                    <Play className="h-3.5 w-3.5 mr-1" />
                    {applyingId === t.id ? "Applying…" : "Apply"}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[12px] text-destructive hover:text-destructive ml-auto"
                  onClick={() => setConfirmDeleteId(t.id)}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                  Delete
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
