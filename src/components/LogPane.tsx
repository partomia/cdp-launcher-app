import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Copy, Download, ArrowDownToLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { logsFetch } from "@/lib/tauri";
import type { LogLine } from "@/lib/types";

const MAX_BUFFER = 10_000; // trim oldest lines beyond this

interface Props {
  clusterId: string;
  phase: string | null;
  isActive: boolean;
}

function isErrorLine(line: string): boolean {
  const l = line.toLowerCase();
  return (
    l.includes("error") ||
    l.includes("fatal") ||
    l.includes("failed") ||
    l.includes("exception") ||
    l.includes("traceback")
  );
}

export function LogPane({ clusterId, phase, isActive }: Props) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [search, setSearch] = useState("");
  const parentRef = useRef<HTMLDivElement>(null);

  // Load historical lines when phase changes
  useEffect(() => {
    if (!phase) {
      setLines([]);
      return;
    }
    setLines([]);
    logsFetch(clusterId, phase, 0, MAX_BUFFER)
      .then(setLines)
      .catch(() => {});
  }, [clusterId, phase]);

  // Subscribe to live log-line events
  useEffect(() => {
    if (!isActive || !phase) return;
    let unlisten: UnlistenFn | null = null;
    listen<LogLine>("log-line", (event) => {
      const ll = event.payload;
      if (ll.cluster_id !== clusterId || ll.phase !== phase) return;
      setLines((prev) => {
        const next = [...prev, ll];
        return next.length > MAX_BUFFER
          ? next.slice(next.length - MAX_BUFFER)
          : next;
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [clusterId, phase, isActive]);

  // Filter by search
  const filtered = search
    ? lines.filter((l) => l.line.toLowerCase().includes(search.toLowerCase()))
    : lines;

  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 20,
  });

  // Auto-scroll to bottom
  useEffect(() => {
    if (!autoScroll || !parentRef.current) return;
    parentRef.current.scrollTop = parentRef.current.scrollHeight;
  }, [lines, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    setAutoScroll(atBottom);
  }, []);

  async function copyToClipboard() {
    const text = filtered.map((l) => l.line).join("\n");
    await navigator.clipboard.writeText(text);
  }

  function saveToFile() {
    const text = filtered.map((l) => `${l.timestamp}\t${l.line}`).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${clusterId}-${phase ?? "log"}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!phase) {
    return (
      <div className="flex items-center justify-center h-full text-[13px] text-muted-foreground">
        Select a phase above to view logs
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full border border-border/40 rounded-md overflow-hidden bg-black/5 dark:bg-black/20">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/40 bg-background flex-shrink-0">
        <input
          type="text"
          placeholder="Search logs…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 text-[12px] bg-transparent outline-none placeholder:text-muted-foreground/60"
        />
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {filtered.length.toLocaleString()} lines
        </span>
        <button
          onClick={() => {
            setAutoScroll(true);
            if (parentRef.current)
              parentRef.current.scrollTop = parentRef.current.scrollHeight;
          }}
          className={cn(
            "p-1 rounded hover:bg-accent",
            autoScroll && "text-primary",
          )}
          title="Auto-scroll"
        >
          <ArrowDownToLine className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={copyToClipboard}
          className="p-1 rounded hover:bg-accent"
          title="Copy to clipboard"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={saveToFile}
          className="p-1 rounded hover:bg-accent"
          title="Save to file"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Virtualized log list */}
      <div
        ref={parentRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto font-mono text-[11px] leading-5"
      >
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            position: "relative",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((vrow) => {
            const ll = filtered[vrow.index];
            const isErr = isErrorLine(ll.line);
            return (
              <div
                key={vrow.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vrow.start}px)`,
                }}
                className={cn(
                  "px-3 whitespace-pre-wrap break-all",
                  isErr
                    ? "text-red-400 dark:text-red-400"
                    : "text-foreground/80",
                  search &&
                    ll.line.toLowerCase().includes(search.toLowerCase()) &&
                    "bg-yellow-100/30 dark:bg-yellow-900/20",
                )}
              >
                {ll.line}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
