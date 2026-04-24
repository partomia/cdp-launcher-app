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
  installStart,
} from "@/lib/tauri";
import { DEFAULT_TFVARS } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
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
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        "w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none",
        "focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/60",
        className
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
        {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wizard state
// ---------------------------------------------------------------------------

interface WizardForm {
  // Step 1: basics
  clusterName: string;
  repoPath: string;
  awsProfile: string;
  awsRegion: string;
  // Step 2: infra
  sshKeyName: string;
  operatorCidr: string;
  // Step 3: passwords
  paywallUser: string;
  paywallPass: string;
  dsPassword: string;
  admPassword: string;
  cmAdminPassword: string;
  dbRootPassword: string;
}

const INITIAL: WizardForm = {
  clusterName: "",
  repoPath: "",
  awsProfile: "",
  awsRegion: DEFAULT_TFVARS.aws_region,
  sshKeyName: DEFAULT_TFVARS.ssh_key_name,
  operatorCidr: "",
  paywallUser: "",
  paywallPass: "",
  dsPassword: "",
  admPassword: "",
  cmAdminPassword: "",
  dbRootPassword: "",
};

const STEPS = ["Basics", "Infrastructure", "Passwords", "Review"];

// ---------------------------------------------------------------------------
// Step panels
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
      <Field label="Cluster name" hint="Short identifier for this CDP deployment">
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
              "focus:ring-1 focus:ring-ring"
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

  return (
    <div className="space-y-5">
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
            ? `Your detected public IP: ${detectedIp} — use ${detectedIp}/32`
            : "Your public IP in CIDR notation, e.g. 1.2.3.4/32"
        }
      >
        <Input
          value={form.operatorCidr}
          onChange={set("operatorCidr")}
          placeholder="1.2.3.4/32"
        />
      </Field>
    </div>
  );
}

function Step3({
  form,
  setForm,
}: {
  form: WizardForm;
  setForm: React.Dispatch<React.SetStateAction<WizardForm>>;
}) {
  const set = (k: keyof WizardForm) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const fields: Array<[keyof WizardForm, string, string]> = [
    ["paywallUser", "CDP Paywall username", "Cloudera portal username"],
    ["paywallPass", "CDP Paywall password", "Cloudera portal password"],
    ["dsPassword", "DS password", "Data Steward / Ranger password"],
    ["admPassword", "Admin password", "Cluster admin password"],
    ["cmAdminPassword", "CM admin password", "Cloudera Manager admin password"],
    ["dbRootPassword", "DB root password", "Database root password"],
  ];

  return (
    <div className="space-y-5">
      <p className="text-[12px] text-muted-foreground">
        These are stored securely in macOS Keychain — never written to disk unencrypted.
      </p>
      {fields.map(([key, label, hint]) => (
        <Field key={key} label={label} hint={hint}>
          <PasswordInput
            value={form[key] as string}
            onChange={set(key)}
            placeholder="••••••••"
          />
        </Field>
      ))}
    </div>
  );
}

function Step4({ form }: { form: WizardForm }) {
  const rows: Array<[string, string]> = [
    ["Cluster name", form.clusterName],
    ["Repo path", form.repoPath],
    ["AWS profile", form.awsProfile],
    ["AWS region", form.awsRegion],
    ["SSH key", form.sshKeyName],
    ["Operator CIDR", form.operatorCidr],
    ["Paywall user", form.paywallUser],
    ["Paywall pass", form.paywallPass ? "••••••••" : "(not set)"],
    ["DS password", form.dsPassword ? "••••••••" : "(not set)"],
    ["Admin password", form.admPassword ? "••••••••" : "(not set)"],
    ["CM admin pass", form.cmAdminPassword ? "••••••••" : "(not set)"],
    ["DB root pass", form.dbRootPassword ? "••••••••" : "(not set)"],
  ];

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-muted-foreground">
        Review your settings. Clicking Launch will write credentials to Keychain and begin the
        installation.
      </p>
      <div className="rounded-lg border border-border/50 divide-y divide-border/50 text-[13px]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex px-4 py-2 gap-4">
            <span className="w-32 text-muted-foreground flex-shrink-0">{label}</span>
            <span className="font-mono text-[12px] break-all">{value || <em className="not-italic text-muted-foreground/50">(empty)</em>}</span>
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
    if (!form.clusterName.trim()) return "Cluster name is required";
    if (!form.repoPath.trim()) return "Repo path is required";
    if (!form.awsProfile.trim()) return "AWS profile is required";
    if (!form.awsRegion.trim()) return "AWS region is required";
  }
  if (step === 1) {
    if (!form.sshKeyName.trim()) return "SSH key name is required";
    if (!form.operatorCidr.trim()) return "Operator CIDR is required";
  }
  if (step === 2) {
    if (!form.paywallUser.trim()) return "Paywall username is required";
    if (!form.paywallPass) return "Paywall password is required";
    if (!form.dsPassword) return "DS password is required";
    if (!form.admPassword) return "Admin password is required";
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

  // Fetch AWS profiles on mount
  useEffect(() => {
    awsProfileList().then(setProfiles).catch(() => {});
  }, []);

  // Detect public IP when user reaches step 2
  useEffect(() => {
    if (step === 1 && !detectedIp) {
      awsDetectPublicIp().then(setDetectedIp).catch(() => {});
    }
  }, [step, detectedIp]);

  function next() {
    const err = validateStep(step, form);
    if (err) { setValidationError(err); return; }
    setValidationError(null);
    setStep((s) => s + 1);
  }

  function back() {
    setValidationError(null);
    setStep((s) => s - 1);
  }

  async function launch() {
    const err = validateStep(step, form);
    if (err) { setValidationError(err); return; }
    setLaunchError(null);
    setLaunching(true);

    try {
      // 1. Store passwords in Keychain
      const secrets: Array<[string, string]> = [
        ["PAYWALL_USER", form.paywallUser],
        ["PAYWALL_PASS", form.paywallPass],
        ["DS_PASSWORD", form.dsPassword],
        ["ADM_PASSWORD", form.admPassword],
        ["CM_ADMIN_PASSWORD", form.cmAdminPassword],
        ["DB_ROOT_PASSWORD", form.dbRootPassword],
      ];
      // We need the cluster ID first — but we don't have it yet.
      // Create the cluster, then write secrets using the new ID.
      const tfvars = {
        ...DEFAULT_TFVARS,
        aws_region: form.awsRegion,
        ssh_key_name: form.sshKeyName,
        operator_ingress_cidrs: form.operatorCidr.trim()
          ? [form.operatorCidr.trim()]
          : [],
      };

      // 2. Create cluster record
      const cluster = await clusterCreate({
        name: form.clusterName.trim(),
        repo_path: form.repoPath.trim(),
        aws_profile: form.awsProfile.trim(),
        aws_region: form.awsRegion.trim(),
        tfvars_json: JSON.stringify(tfvars),
      });

      // 3. Write secrets with real cluster ID
      for (const [key, value] of secrets) {
        await keychainSet(cluster.id, key, value);
      }

      // 4. Kick off install
      await installStart(cluster.id);

      // 5. Navigate to cluster detail
      navigate(`/cluster/${cluster.id}`);
    } catch (e: unknown) {
      const msg = e instanceof Error
        ? e.message
        : (typeof e === "object" && e !== null && "message" in e)
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
            <div key={label} className="flex items-center flex-1 last:flex-none">
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    "h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-semibold",
                    i < step
                      ? "bg-primary text-primary-foreground"
                      : i === step
                        ? "bg-primary/20 text-primary border border-primary"
                        : "bg-muted text-muted-foreground"
                  )}
                >
                  {i + 1}
                </div>
                <span
                  className={cn(
                    "text-[12px] font-medium",
                    i === step ? "text-foreground" : "text-muted-foreground"
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
          {step === 0 && <Step1 form={form} setForm={setForm} profiles={profiles} />}
          {step === 1 && <Step2 form={form} setForm={setForm} detectedIp={detectedIp} />}
          {step === 2 && <Step3 form={form} setForm={setForm} />}
          {step === 3 && <Step4 form={form} />}
        </div>

        {/* Validation / launch errors */}
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
