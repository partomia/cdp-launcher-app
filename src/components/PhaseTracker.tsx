import { useEffect, useState } from "react";
import {
  CheckCircle,
  XCircle,
  Loader2,
  Circle,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { clusterPhaseEvents } from "@/lib/tauri";
import type { PhaseEvent } from "@/lib/types";
import { PHASE_DEFS } from "@/lib/types";

interface Props {
  clusterId: string;
  isActive: boolean; // poll while true
  selectedPhase: string | null;
  onSelectPhase: (phase: string) => void;
}

function elapsedLabel(startedAt: string, finishedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const secs = Math.floor((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "running":
      return (
        <Loader2 className="h-4 w-4 text-blue-500 animate-spin flex-shrink-0" />
      );
    case "success":
      return <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-destructive flex-shrink-0" />;
    case "interrupted":
      return <AlertCircle className="h-4 w-4 text-yellow-500 flex-shrink-0" />;
    default:
      return (
        <Circle className="h-4 w-4 text-muted-foreground/40 flex-shrink-0" />
      );
  }
}

export function PhaseTracker({
  clusterId,
  isActive,
  selectedPhase,
  onSelectPhase,
}: Props) {
  const [events, setEvents] = useState<PhaseEvent[]>([]);
  const [tick, setTick] = useState(0);

  // Poll while install is active
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const load = () => {
      clusterPhaseEvents(clusterId)
        .then(setEvents)
        .catch(() => {});
    };
    load();
    if (isActive) {
      id = setInterval(() => {
        load();
        setTick((t) => t + 1);
      }, 2500);
    }
    return () => {
      if (id) clearInterval(id);
    };
  }, [clusterId, isActive]);

  // Build a map from phase key → event (last one wins if duplicates)
  const eventMap: Record<string, PhaseEvent> = {};
  for (const ev of events) {
    eventMap[ev.phase] = ev;
  }

  // Known phase keys so we can detect extras (e.g. make_tf_destroy)
  const knownKeys = new Set<string>(PHASE_DEFS.map((d) => d.key));

  // Extra phases present in DB but not in PHASE_DEFS (destroy, remediation, …)
  const extraPhases = events
    .filter((ev) => !knownKeys.has(ev.phase))
    .reduce<PhaseEvent[]>((acc, ev) => {
      if (!acc.find((e) => e.phase === ev.phase)) acc.push(ev);
      return acc;
    }, []);

  const EXTRA_LABELS: Record<string, string> = {
    make_tf_destroy: "Terraform Destroy",
    remediation: "Remediation",
  };

  function PhaseRow({
    phaseKey,
    label,
    ev,
    disabled,
  }: {
    phaseKey: string;
    label: string;
    ev: PhaseEvent | undefined;
    disabled?: boolean;
  }) {
    const status = ev?.status ?? "queued";
    const isSelected = selectedPhase === phaseKey;
    return (
      <button
        onClick={() => ev && onSelectPhase(phaseKey)}
        disabled={disabled ?? !ev}
        className={cn(
          "w-full flex items-center gap-3 px-3 py-2 rounded-md text-left transition-colors",
          isSelected
            ? "bg-primary/10 text-primary"
            : "hover:bg-accent disabled:opacity-40 disabled:cursor-default",
        )}
      >
        <StatusIcon status={status} />
        <span className="flex-1 text-[13px] font-medium">{label}</span>
        {ev && (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {elapsedLabel(ev.started_at, ev.finished_at)}
          </span>
        )}
        {ev?.error_summary && (
          <span
            className="text-[11px] text-destructive truncate max-w-[140px]"
            title={ev.error_summary}
          >
            {ev.error_summary}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="space-y-0.5">
      {PHASE_DEFS.map(({ key, label }) => (
        <PhaseRow
          key={key}
          phaseKey={key}
          label={label}
          ev={eventMap[key]}
        />
      ))}

      {/* Extra phases (destroy, remediation, …) — shown only when they have events */}
      {extraPhases.length > 0 && (
        <>
          <div className="mx-3 my-1 border-t border-border/40" />
          {extraPhases.map((ev) => (
            <PhaseRow
              key={ev.phase}
              phaseKey={ev.phase}
              label={EXTRA_LABELS[ev.phase] ?? ev.phase}
              ev={ev}
            />
          ))}
        </>
      )}

      {/* Invisible dependency on tick to keep elapsed times updating */}
      <span className="sr-only">{tick}</span>
    </div>
  );
}
