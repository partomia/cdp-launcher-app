import { useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Terminal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { runRemediation } from "@/lib/tauri";
import type { ErrorHint } from "@/lib/types";

interface Props {
  clusterId: string;
  hint: ErrorHint;
  onDismiss: () => void;
}

export function ErrorHintBanner({ clusterId, hint, onDismiss }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function applyFix() {
    if (!hint.remediation_command) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setRunning(true);
    setConfirming(false);
    try {
      await runRemediation(clusterId, hint.remediation_command);
      setResult("Remediation command started — watch the log pane for output.");
    } catch (e: unknown) {
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === "object" && e !== null && "message" in e
            ? String((e as { message: unknown }).message)
            : String(e);
      setResult(`Failed: ${msg}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div
      className={cn(
        "border-l-4 rounded-md text-[12px]",
        hint.severity === "blocker"
          ? "border-destructive bg-destructive/5 dark:bg-destructive/10"
          : "border-yellow-500 bg-yellow-50/50 dark:bg-yellow-950/20",
      )}
    >
      <div className="flex items-start gap-3 px-3 py-2">
        <AlertTriangle
          className={cn(
            "h-3.5 w-3.5 mt-0.5 flex-shrink-0",
            hint.severity === "blocker"
              ? "text-destructive"
              : "text-yellow-600",
          )}
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{hint.summary}</span>
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full font-medium uppercase",
                hint.severity === "blocker"
                  ? "bg-destructive/20 text-destructive"
                  : "bg-yellow-200/60 text-yellow-800 dark:bg-yellow-800/30 dark:text-yellow-300",
              )}
            >
              {hint.severity}
            </span>
          </div>

          {expanded && (
            <div className="mt-2 space-y-2">
              <p className="text-muted-foreground">{hint.remediation}</p>
              {hint.remediation_command && (
                <div className="flex items-start gap-2 bg-muted/50 rounded px-2 py-1.5">
                  <Terminal className="h-3 w-3 mt-0.5 flex-shrink-0 text-muted-foreground" />
                  <code className="text-[11px] font-mono break-all">
                    {hint.remediation_command}
                  </code>
                </div>
              )}
              {result && (
                <p
                  className={cn(
                    "text-[11px]",
                    result.startsWith("Failed")
                      ? "text-destructive"
                      : "text-green-600 dark:text-green-400",
                  )}
                >
                  {result}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {hint.remediation_command &&
            expanded &&
            (confirming ? (
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-muted-foreground">
                  Confirm?
                </span>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-6 text-[10px] px-2"
                  onClick={applyFix}
                  disabled={running}
                >
                  Yes, run
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[10px] px-2"
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[10px] px-2"
                onClick={applyFix}
                disabled={running}
              >
                {running ? "Running…" : "Apply Fix"}
              </Button>
            ))}
          <button
            onClick={() => setExpanded((e) => !e)}
            className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 text-muted-foreground"
            title={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </button>
          <button
            onClick={onDismiss}
            className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 text-muted-foreground"
            title="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
