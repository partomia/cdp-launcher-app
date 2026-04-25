import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  settingsGet,
  settingsSet,
  forgetAllSecrets,
  deleteAllClusters,
} from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[13px] font-medium">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  readOnly,
}: {
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  readOnly?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      readOnly={readOnly}
      onChange={(e) => onChange?.(e.target.value)}
      placeholder={placeholder}
      className={cn(
        "w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none",
        "placeholder:text-muted-foreground/60",
        readOnly
          ? "text-muted-foreground cursor-default"
          : "focus:ring-1 focus:ring-ring",
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

export default function Settings() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [dangerConfirm, setDangerConfirm] = useState<
    "secrets" | "metadata" | null
  >(null);
  const [dangerBusy, setDangerBusy] = useState(false);
  const [dangerMsg, setDangerMsg] = useState<string | null>(null);
  const [dataDir, setDataDir] = useState("");

  useEffect(() => {
    settingsGet()
      .then(setSettings)
      .catch(() => {});
    // Data directory is stable based on macOS convention
    setDataDir(`~/Library/Application Support/com.partomia.cdp-launcher`);
  }, []);

  function set(key: string, value: string) {
    setSettings((s) => ({ ...s, [key]: value }));
    setSaved(false);
  }

  async function save() {
    for (const [key, value] of Object.entries(settings)) {
      await settingsSet(key, value);
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function runDangerAction() {
    if (!dangerConfirm) return;
    setDangerBusy(true);
    setDangerMsg(null);
    try {
      if (dangerConfirm === "secrets") {
        await forgetAllSecrets();
        setDangerMsg("All Keychain secrets have been removed.");
      } else {
        await deleteAllClusters();
        setDangerMsg("All cluster metadata has been deleted.");
      }
    } catch (e: unknown) {
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === "object" && e !== null && "message" in e
            ? String((e as { message: unknown }).message)
            : String(e);
      setDangerMsg(`Error: ${msg}`);
    } finally {
      setDangerBusy(false);
      setDangerConfirm(null);
    }
  }

  const version = "0.1.0";

  return (
    <div className="p-8 max-w-2xl space-y-10">
      {/* Installer repo */}
      <section className="space-y-4">
        <h2 className="text-[14px] font-semibold">Defaults</h2>
        <Field
          label="Installer repo path"
          hint="Default path to the cdp-732-automation clone (overridable per cluster in the wizard)"
        >
          <TextInput
            value={settings.default_repo_path ?? ""}
            onChange={(v) => set("default_repo_path", v)}
            placeholder="/Users/you/IdeaProjects/cdp-732-automation"
          />
        </Field>
        <Field label="Default AWS profile">
          <TextInput
            value={settings.default_aws_profile ?? ""}
            onChange={(v) => set("default_aws_profile", v)}
            placeholder="default"
          />
        </Field>
        <Field label="Default region">
          <TextInput
            value={settings.default_aws_region ?? ""}
            onChange={(v) => set("default_aws_region", v)}
            placeholder="ap-south-1"
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save}>
            Save
          </Button>
          {saved && (
            <span className="text-[12px] text-green-600 dark:text-green-400">
              Saved ✓
            </span>
          )}
        </div>
      </section>

      {/* Data directory */}
      <section className="space-y-4">
        <h2 className="text-[14px] font-semibold">Data directory</h2>
        <Field
          label="Location"
          hint="SQLite database (launcher.db) and phase log files live here"
        >
          <TextInput value={dataDir} readOnly />
        </Field>
        <p className="text-[12px] text-muted-foreground">
          Secrets are stored in the macOS Keychain under service{" "}
          <code className="font-mono">com.partomia.cdp-launcher</code>.
        </p>
      </section>

      {/* Danger zone */}
      <section className="space-y-4 border border-destructive/30 rounded-lg p-4">
        <h2 className="text-[14px] font-semibold text-destructive">
          Danger zone
        </h2>

        <div className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[13px] font-medium">Forget all secrets</p>
              <p className="text-[12px] text-muted-foreground">
                Removes all CDP passwords from macOS Keychain for every cluster.
              </p>
            </div>
            {dangerConfirm === "secrets" ? (
              <div className="flex gap-1.5 flex-shrink-0">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={runDangerAction}
                  disabled={dangerBusy}
                >
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDangerConfirm(null)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="flex-shrink-0 text-destructive border-destructive/40 hover:bg-destructive/10"
                onClick={() => setDangerConfirm("secrets")}
              >
                Forget secrets
              </Button>
            )}
          </div>

          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[13px] font-medium">
                Delete all cluster metadata
              </p>
              <p className="text-[12px] text-muted-foreground">
                Removes all cluster rows from the SQLite database. Log files on
                disk are kept.
              </p>
            </div>
            {dangerConfirm === "metadata" ? (
              <div className="flex gap-1.5 flex-shrink-0">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={runDangerAction}
                  disabled={dangerBusy}
                >
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDangerConfirm(null)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="flex-shrink-0 text-destructive border-destructive/40 hover:bg-destructive/10"
                onClick={() => setDangerConfirm("metadata")}
              >
                Delete metadata
              </Button>
            )}
          </div>

          {dangerMsg && (
            <p
              className={cn(
                "text-[12px]",
                dangerMsg.startsWith("Error")
                  ? "text-destructive"
                  : "text-green-600 dark:text-green-400",
              )}
            >
              {dangerMsg}
            </p>
          )}
        </div>
      </section>

      {/* About */}
      <section className="space-y-2">
        <h2 className="text-[14px] font-semibold">About</h2>
        <div className="rounded-lg border border-border/50 divide-y divide-border/50 text-[13px]">
          {[
            ["Version", version],
            ["Repository", "github.com/partomia/cdp-launcher-app"],
            ["License", "MIT"],
          ].map(([label, value]) => (
            <div key={label} className="flex px-4 py-2.5 gap-4">
              <span className="w-24 text-muted-foreground">{label}</span>
              <span className="font-mono text-[12px]">{value}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
