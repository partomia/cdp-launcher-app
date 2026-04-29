import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, ChevronLeft, Rocket, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  awsProfileList,
  awsDetectPublicIp,
  keychainSet,
  clusterCreate,
  clusterValidateRepoPath,
  installStart,
  settingsGet,
} from "@/lib/tauri";
import { DEFAULT_TFVARS } from "@/lib/types";

// ---------------------------------------------------------------------------
// Reusable form primitives
// ---------------------------------------------------------------------------

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}
function Field({ label, hint, children }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[13px] font-medium">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  className,
  type = "text",
  min,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  type?: string;
  min?: number;
}) {
  return (
    <input
      type={type}
      value={value}
      min={min}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        "w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none",
        "focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/60",
        className,
      )}
    />
  );
}

function PasswordInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        type={show ? "text" : "password"}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="pr-9"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
      >
        {show ? (
          <EyeOff className="h-3.5 w-3.5" />
        ) : (
          <Eye className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wizard state
// ---------------------------------------------------------------------------

interface WizardForm {
  // Step 0: provider
  provider: string;
  // Step 1: basics
  clusterName: string;
  repoPath: string;
  awsProfile: string;
  awsRegion: string;
  // Step 2: infrastructure
  sshKeyName: string;
  operatorCidr: string;
  workerCount: number;
  directoryType: string; // "freeipa" | "ldap" | "ad"
  ldapUrl: string;
  ldapBindDn: string;
  ldapBaseDn: string;
  // Step 3: passwords
  paywallUser: string;
  paywallPass: string;
  dsPassword: string;     // FreeIPA only
  admPassword: string;    // FreeIPA only
  ldapBindPassword: string; // LDAP/AD only
  cmAdminPassword: string;
  dbRootPassword: string;
}

const INITIAL: WizardForm = {
  provider: "aws",
  clusterName: "",
  repoPath: "",
  awsProfile: "",
  awsRegion: DEFAULT_TFVARS.aws_region,
  sshKeyName: DEFAULT_TFVARS.ssh_key_name,
  operatorCidr: "",
  workerCount: 5,
  directoryType: "freeipa",
  ldapUrl: "",
  ldapBindDn: "",
  ldapBaseDn: "",
  paywallUser: "",
  paywallPass: "",
  dsPassword: "",
  admPassword: "",
  ldapBindPassword: "",
  cmAdminPassword: "",
  dbRootPassword: "",
};

const STEPS = ["Provider", "Basics", "Infrastructure", "Passwords", "Review"];

// ---------------------------------------------------------------------------
// Step 0 — Provider selector
// ---------------------------------------------------------------------------

interface ProviderOption {
  id: string;
  label: string;
  description: string;
  available: boolean;
}

const PROVIDERS: ProviderOption[] = [
  {
    id: "aws",
    label: "Amazon Web Services",
    description: "Deploy to AWS with Terraform + Ansible automation",
    available: true,
  },
  {
    id: "gcp",
    label: "Google Cloud Platform",
    description: "GCP support coming soon",
    available: false,
  },
  {
    id: "azure",
    label: "Microsoft Azure",
    description: "Azure support coming soon",
    available: false,
  },
  {
    id: "onprem",
    label: "On-Premises",
    description: "Bare-metal / on-prem support coming soon",
    available: false,
  },
];

function Step0({
  form,
  setForm,
}: {
  form: WizardForm;
  setForm: React.Dispatch<React.SetStateAction<WizardForm>>;
}) {
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-muted-foreground mb-4">
        Select the target cloud or infrastructure provider for this CDP
        deployment.
      </p>
      {PROVIDERS.map((p) => (
        <button
          key={p.id}
          type="button"
          disabled={!p.available}
          onClick={() =>
            p.available && setForm((f) => ({ ...f, provider: p.id }))
          }
          className={cn(
            "w-full text-left rounded-lg border px-4 py-3 transition-colors",
            !p.available
              ? "border-border/30 bg-muted/20 cursor-not-allowed opacity-50"
              : form.provider === p.id
                ? "border-primary bg-primary/5 ring-1 ring-primary"
                : "border-border/60 hover:border-primary/50 hover:bg-muted/30",
          )}
        >
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium">{p.label}</span>
            {!p.available && (
              <span className="text-[10px] font-medium text-muted-foreground bg-muted rounded-full px-2 py-0.5">
                Coming soon
              </span>
            )}
            {p.available && form.provider === p.id && (
              <span className="text-[10px] font-medium text-primary bg-primary/10 rounded-full px-2 py-0.5">
                Selected
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {p.description}
          </p>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Basics
// ---------------------------------------------------------------------------

function Step1({
  form,
  setForm,
  profiles,
}: {
  form: WizardForm;
  setForm: React.Dispatch<React.SetStateAction<WizardForm>>;
  profiles: string[];
}) {
  const set = (k: keyof WizardForm) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="space-y-5">
      <Field
        label="Cluster name"
        hint="Short identifier for this CDP deployment"
      >
        <Input
          value={form.clusterName}
          onChange={set("clusterName")}
          placeholder="prod-ap-south-1"
        />
      </Field>

      <Field
        label="Installer repo path"
        hint="Absolute path to your cdp-732-automation clone"
      >
        <Input
          value={form.repoPath}
          onChange={set("repoPath")}
          placeholder="/Users/you/cdp-732-automation"
        />
      </Field>

      <Field label="AWS profile">
        {profiles.length > 0 ? (
          <select
            value={form.awsProfile}
            onChange={(e) => set("awsProfile")(e.target.value)}
            className={cn(
              "w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none",
              "focus:ring-1 focus:ring-ring",
            )}
          >
            <option value="">Select a profile…</option>
            {profiles.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        ) : (
          <Input
            value={form.awsProfile}
            onChange={set("awsProfile")}
            placeholder="default"
          />
        )}
      </Field>

      <Field label="AWS region">
        <Input
          value={form.awsRegion}
          onChange={set("awsRegion")}
          placeholder="ap-south-1"
        />
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Infrastructure (SSH, CIDR, worker count, directory type)
// ---------------------------------------------------------------------------

const DIR_OPTIONS = [
  {
    id: "freeipa",
    label: "FreeIPA",
    description:
      "Install FreeIPA server — provides Kerberos KDC + LDAP in one step",
  },
  {
    id: "ldap",
    label: "External LDAP",
    description:
      "Use an existing OpenLDAP / 389-DS server — skip FreeIPA install",
  },
  {
    id: "ad",
    label: "Active Directory",
    description: "Use Microsoft AD for Kerberos + LDAP — skip FreeIPA install",
  },
];

function Step2({
  form,
  setForm,
  detectedIp,
}: {
  form: WizardForm;
  setForm: React.Dispatch<React.SetStateAction<WizardForm>>;
  detectedIp: string | null;
}) {
  const set = (k: keyof WizardForm) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const isExternal = form.directoryType === "ldap" || form.directoryType === "ad";

  return (
    <div className="space-y-6">
      {/* SSH key + CIDR */}
      <Field label="SSH key pair name" hint="Must exist in your AWS region">
        <Input
          value={form.sshKeyName}
          onChange={set("sshKeyName")}
          placeholder="cdp732"
        />
      </Field>

      <Field
        label="Operator ingress CIDR"
        hint={
          detectedIp
            ? `Detected IP: ${detectedIp} → use ${detectedIp}/32`
            : "Your public IP in CIDR notation, e.g. 1.2.3.4/32"
        }
      >
        <Input
          value={form.operatorCidr}
          onChange={set("operatorCidr")}
          placeholder="1.2.3.4/32"
        />
      </Field>

      {/* Worker count */}
      <Field
        label="Worker node count"
        hint="Minimum 3. Each worker gets 4 × 1 TB data disks by default."
      >
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={3}
            max={20}
            value={form.workerCount}
            onChange={(e) =>
              setForm((f) => ({ ...f, workerCount: Number(e.target.value) }))
            }
            className="flex-1 accent-primary"
          />
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={3}
              value={form.workerCount}
              onChange={(e) => {
                const n = Math.max(3, Number(e.target.value));
                setForm((f) => ({ ...f, workerCount: n }));
              }}
              className="w-16 rounded-md border border-border bg-background px-2 py-1.5 text-[13px] outline-none focus:ring-1 focus:ring-ring text-center"
            />
            <span className="text-[12px] text-muted-foreground">nodes</span>
          </div>
        </div>
      </Field>

      {/* Directory / identity type */}
      <div className="space-y-2">
        <label className="block text-[13px] font-medium">
          Identity & directory service
        </label>
        <div className="space-y-2">
          {DIR_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setForm((f) => ({ ...f, directoryType: opt.id }))}
              className={cn(
                "w-full text-left rounded-lg border px-4 py-2.5 transition-colors",
                form.directoryType === opt.id
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border/60 hover:border-primary/40 hover:bg-muted/20",
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium">{opt.label}</span>
                {form.directoryType === opt.id && (
                  <span className="text-[10px] font-medium text-primary bg-primary/10 rounded-full px-2 py-0.5">
                    Selected
                  </span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {opt.description}
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* External LDAP/AD connection details */}
      {isExternal && (
        <div className="space-y-4 rounded-lg border border-border/60 bg-muted/10 p-4">
          <p className="text-[12px] font-medium text-muted-foreground">
            {form.directoryType === "ad"
              ? "Active Directory connection"
              : "External LDAP connection"}
          </p>

          <Field
            label="Server URL"
            hint={
              form.directoryType === "ad"
                ? "e.g. ldap://dc1.corp.example.com:389 or ldaps://dc1.corp.example.com:636"
                : "e.g. ldap://ldap.example.com:389 or ldaps://ldap.example.com:636"
            }
          >
            <Input
              value={form.ldapUrl}
              onChange={set("ldapUrl")}
              placeholder={
                form.directoryType === "ad"
                  ? "ldap://dc1.corp.example.com:389"
                  : "ldap://ldap.example.com:389"
              }
            />
          </Field>

          <Field
            label="Bind DN"
            hint="The service account DN Cloudera Manager uses to search the directory"
          >
            <Input
              value={form.ldapBindDn}
              onChange={set("ldapBindDn")}
              placeholder={
                form.directoryType === "ad"
                  ? "cn=cm-bind,cn=Users,dc=corp,dc=example,dc=com"
                  : "cn=cm-bind,ou=serviceaccounts,dc=example,dc=com"
              }
            />
          </Field>

          <Field
            label="Base DN"
            hint="Root of the directory tree to search for users and groups"
          >
            <Input
              value={form.ldapBaseDn}
              onChange={set("ldapBaseDn")}
              placeholder={
                form.directoryType === "ad"
                  ? "dc=corp,dc=example,dc=com"
                  : "dc=example,dc=com"
              }
            />
          </Field>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Passwords (conditional on directory type)
// ---------------------------------------------------------------------------

function Step3({
  form,
  setForm,
}: {
  form: WizardForm;
  setForm: React.Dispatch<React.SetStateAction<WizardForm>>;
}) {
  const set = (k: keyof WizardForm) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const isFreeipa = form.directoryType === "freeipa";

  return (
    <div className="space-y-5">
      <p className="text-[12px] text-muted-foreground">
        Credentials are stored in macOS Keychain — never written to disk
        unencrypted.
      </p>

      <Field label="CDP Paywall username" hint="Cloudera portal username">
        <Input
          value={form.paywallUser}
          onChange={set("paywallUser")}
          placeholder="user@example.com"
        />
      </Field>

      <Field label="CDP Paywall password" hint="Cloudera portal password">
        <PasswordInput
          value={form.paywallPass}
          onChange={set("paywallPass")}
          placeholder="••••••••"
        />
      </Field>

      {isFreeipa && (
        <>
          <Field
            label="DS password"
            hint="389-DS Directory Manager password (FreeIPA internal)"
          >
            <PasswordInput
              value={form.dsPassword}
              onChange={set("dsPassword")}
              placeholder="••••••••"
            />
          </Field>

          <Field
            label="Admin password"
            hint="FreeIPA 'admin' principal password"
          >
            <PasswordInput
              value={form.admPassword}
              onChange={set("admPassword")}
              placeholder="••••••••"
            />
          </Field>
        </>
      )}

      {!isFreeipa && (
        <Field
          label="LDAP bind password"
          hint={`Password for the CM service account (bind DN entered in the previous step)`}
        >
          <PasswordInput
            value={form.ldapBindPassword}
            onChange={set("ldapBindPassword")}
            placeholder="••••••••"
          />
        </Field>
      )}

      <Field label="CM admin password" hint="Cloudera Manager admin password">
        <PasswordInput
          value={form.cmAdminPassword}
          onChange={set("cmAdminPassword")}
          placeholder="••••••••"
        />
      </Field>

      <Field label="DB root password" hint="Database root password">
        <PasswordInput
          value={form.dbRootPassword}
          onChange={set("dbRootPassword")}
          placeholder="••••••••"
        />
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Review
// ---------------------------------------------------------------------------

function Step4({ form }: { form: WizardForm }) {
  const providerLabels: Record<string, string> = {
    aws: "Amazon Web Services",
    gcp: "Google Cloud Platform",
    azure: "Microsoft Azure",
    onprem: "On-Premises",
  };
  const dirLabels: Record<string, string> = {
    freeipa: "FreeIPA (install on cluster)",
    ldap: "External LDAP",
    ad: "Active Directory",
  };

  const rows: Array<[string, string]> = [
    ["Provider", providerLabels[form.provider] ?? form.provider],
    ["Cluster name", form.clusterName],
    ["Repo path", form.repoPath],
    ["AWS profile", form.awsProfile],
    ["AWS region", form.awsRegion],
    ["SSH key", form.sshKeyName],
    ["Operator CIDR", form.operatorCidr],
    ["Worker count", String(form.workerCount)],
    ["Directory", dirLabels[form.directoryType] ?? form.directoryType],
    ...(form.directoryType !== "freeipa"
      ? ([
          ["LDAP URL", form.ldapUrl || "(not set)"],
          ["LDAP bind DN", form.ldapBindDn || "(not set)"],
          ["LDAP base DN", form.ldapBaseDn || "(not set)"],
        ] as Array<[string, string]>)
      : []),
    ["Paywall user", form.paywallUser],
    ["Paywall pass", form.paywallPass ? "••••••••" : "(not set)"],
    ...(form.directoryType === "freeipa"
      ? ([
          ["DS password", form.dsPassword ? "••••••••" : "(not set)"],
          ["Admin password", form.admPassword ? "••••••••" : "(not set)"],
        ] as Array<[string, string]>)
      : ([
          [
            "LDAP bind pass",
            form.ldapBindPassword ? "••••••••" : "(not set)",
          ],
        ] as Array<[string, string]>)),
    ["CM admin pass", form.cmAdminPassword ? "••••••••" : "(not set)"],
    ["DB root pass", form.dbRootPassword ? "••••••••" : "(not set)"],
  ];

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-muted-foreground">
        Review your settings. Clicking Launch will write credentials to Keychain
        and begin the installation.
      </p>
      <div className="rounded-lg border border-border/50 divide-y divide-border/50 text-[13px]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex px-4 py-2 gap-4">
            <span className="w-32 text-muted-foreground flex-shrink-0">
              {label}
            </span>
            <span className="font-mono text-[12px] break-all">
              {value || (
                <em className="not-italic text-muted-foreground/50">(empty)</em>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateStep(step: number, form: WizardForm): string | null {
  if (step === 0) {
    if (!form.provider) return "Select a provider";
  }
  if (step === 1) {
    if (!form.clusterName.trim()) return "Cluster name is required";
    if (!form.repoPath.trim()) return "Repo path is required";
    if (!form.awsProfile.trim()) return "AWS profile is required";
    if (!form.awsRegion.trim()) return "AWS region is required";
  }
  if (step === 2) {
    if (!form.sshKeyName.trim()) return "SSH key name is required";
    if (!form.operatorCidr.trim()) return "Operator CIDR is required";
    if (form.workerCount < 3) return "Worker count must be at least 3";
    if (form.directoryType !== "freeipa") {
      if (!form.ldapUrl.trim()) return "LDAP server URL is required";
      if (!form.ldapBindDn.trim()) return "LDAP bind DN is required";
      if (!form.ldapBaseDn.trim()) return "LDAP base DN is required";
    }
  }
  if (step === 3) {
    if (!form.paywallUser.trim()) return "Paywall username is required";
    if (!form.paywallPass) return "Paywall password is required";
    if (form.directoryType === "freeipa") {
      if (!form.dsPassword) return "DS password is required";
      if (!form.admPassword) return "Admin password is required";
    } else {
      if (!form.ldapBindPassword) return "LDAP bind password is required";
    }
    if (!form.cmAdminPassword) return "CM admin password is required";
    if (!form.dbRootPassword) return "DB root password is required";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

export default function InstallWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<WizardForm>(INITIAL);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [detectedIp, setDetectedIp] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  useEffect(() => {
    awsProfileList().then(setProfiles).catch(() => {});
    settingsGet()
      .then((settings) => {
        setForm((f) => ({
          ...f,
          repoPath: f.repoPath || settings.default_repo_path || "",
          awsProfile: f.awsProfile || settings.default_aws_profile || "",
          awsRegion:
            f.awsRegion === INITIAL.awsRegion
              ? settings.default_aws_region || f.awsRegion
              : f.awsRegion,
        }));
      })
      .catch(() => {});
  }, []);

  // Detect public IP when user reaches Infrastructure step
  useEffect(() => {
    if (step === 2 && !detectedIp) {
      awsDetectPublicIp()
        .then(setDetectedIp)
        .catch(() => {});
    }
  }, [step, detectedIp]);

  function next() {
    const err = validateStep(step, form);
    if (err) {
      setValidationError(err);
      return;
    }
    setValidationError(null);
    setStep((s) => s + 1);
  }

  function back() {
    setValidationError(null);
    setStep((s) => s - 1);
  }

  async function launch() {
    const err = validateStep(step, form);
    if (err) {
      setValidationError(err);
      return;
    }
    setLaunchError(null);
    setLaunching(true);

    try {
      const repoCheck = await clusterValidateRepoPath(form.repoPath.trim());
      if (!repoCheck.ok) {
        setLaunchError(repoCheck.message);
        setLaunching(false);
        return;
      }

      // Build tfvars config
      const tfvars = {
        ...DEFAULT_TFVARS,
        aws_region: form.awsRegion,
        ssh_key_name: form.sshKeyName,
        operator_ingress_cidrs: form.operatorCidr.trim()
          ? [form.operatorCidr.trim()]
          : [],
        worker_count: form.workerCount,
        directory_type: form.directoryType,
        ...(form.directoryType !== "freeipa"
          ? {
              ldap_url: form.ldapUrl,
              ldap_bind_dn: form.ldapBindDn,
              ldap_base_dn: form.ldapBaseDn,
            }
          : {}),
      };

      // Create cluster record
      const cluster = await clusterCreate({
        name: form.clusterName.trim(),
        repo_path: form.repoPath.trim(),
        aws_profile: form.awsProfile.trim(),
        aws_region: form.awsRegion.trim(),
        tfvars_json: JSON.stringify(tfvars),
        provider: form.provider,
      });

      // Write secrets to keychain
      const secrets: Array<[string, string]> = [
        ["PAYWALL_USER", form.paywallUser],
        ["PAYWALL_PASS", form.paywallPass],
        ["CM_ADMIN_PASSWORD", form.cmAdminPassword],
        ["DB_ROOT_PASSWORD", form.dbRootPassword],
      ];

      if (form.directoryType === "freeipa") {
        secrets.push(["DS_PASSWORD", form.dsPassword]);
        secrets.push(["ADM_PASSWORD", form.admPassword]);
      } else {
        secrets.push(["LDAP_BIND_PASSWORD", form.ldapBindPassword]);
        // Still write placeholder values so the keychain keys exist
        secrets.push(["DS_PASSWORD", ""]);
        secrets.push(["ADM_PASSWORD", ""]);
      }

      for (const [key, value] of secrets) {
        await keychainSet(cluster.id, key, value);
      }

      // Kick off install
      await installStart(cluster.id);

      navigate(`/cluster/${cluster.id}`);
    } catch (e: unknown) {
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === "object" && e !== null && "message" in e
            ? String((e as { message: unknown }).message)
            : String(e);
      setLaunchError(msg);
      setLaunching(false);
    }
  }

  const isLast = step === STEPS.length - 1;

  return (
    <div className="flex justify-center px-8 py-10">
      <div className="w-full max-w-lg space-y-8">
        {/* Step indicators */}
        <div className="flex items-center gap-0">
          {STEPS.map((label, i) => (
            <div
              key={label}
              className="flex items-center flex-1 last:flex-none"
            >
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    "h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-semibold",
                    i < step
                      ? "bg-primary text-primary-foreground"
                      : i === step
                        ? "bg-primary/20 text-primary border border-primary"
                        : "bg-muted text-muted-foreground",
                  )}
                >
                  {i + 1}
                </div>
                <span
                  className={cn(
                    "text-[12px] font-medium",
                    i === step ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div className="flex-1 h-px bg-border/60 mx-3" />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="rounded-xl border border-border/50 bg-card p-6 shadow-sm">
          {step === 0 && <Step0 form={form} setForm={setForm} />}
          {step === 1 && (
            <Step1 form={form} setForm={setForm} profiles={profiles} />
          )}
          {step === 2 && (
            <Step2 form={form} setForm={setForm} detectedIp={detectedIp} />
          )}
          {step === 3 && <Step3 form={form} setForm={setForm} />}
          {step === 4 && <Step4 form={form} />}
        </div>

        {/* Errors */}
        {(validationError || launchError) && (
          <p className="text-[12px] text-destructive">
            {validationError ?? launchError}
          </p>
        )}

        {/* Navigation */}
        <div className="flex justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={back}
            disabled={step === 0 || launching}
          >
            <ChevronLeft className="h-3.5 w-3.5 mr-1" />
            Back
          </Button>

          {isLast ? (
            <Button size="sm" onClick={launch} disabled={launching}>
              {launching ? (
                "Launching…"
              ) : (
                <>
                  <Rocket className="h-3.5 w-3.5 mr-1.5" />
                  Launch Install
                </>
              )}
            </Button>
          ) : (
            <Button size="sm" onClick={next}>
              Next
              <ChevronRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
