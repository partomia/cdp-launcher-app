import { useState } from "react";
import { Button } from "@/components/ui/button";
import { awsProfileList, keychainGet, keychainSet } from "@/lib/tauri";
import type { AppError } from "@/lib/types";

type TestState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ok"; detail: string }
  | { status: "err"; detail: string };

function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

function errorMessage(e: unknown): string {
  if (isAppError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export default function Settings() {
  const [awsTest, setAwsTest] = useState<TestState>({ status: "idle" });
  const [kcTest, setKcTest] = useState<TestState>({ status: "idle" });

  async function runAwsTest() {
    setAwsTest({ status: "running" });
    try {
      const profiles = await awsProfileList();
      setAwsTest({
        status: "ok",
        detail: profiles.length > 0
          ? `Found ${profiles.length} profile(s): ${profiles.join(", ")}`
          : "No profiles found in ~/.aws/config",
      });
    } catch (e) {
      setAwsTest({ status: "err", detail: errorMessage(e) });
    }
  }

  async function runKeychainTest() {
    setKcTest({ status: "running" });
    const testClusterId = "__smoke_test__";
    const testKey = "SMOKE_TEST";
    const testValue = "cdp-launcher-keychain-ok";
    try {
      await keychainSet(testClusterId, testKey, testValue);
      const readBack = await keychainGet(testClusterId, testKey);
      if (readBack === testValue) {
        setKcTest({ status: "ok", detail: "Write → read → match ✓" });
      } else {
        setKcTest({ status: "err", detail: `Value mismatch: got "${readBack}"` });
      }
    } catch (e) {
      setKcTest({ status: "err", detail: errorMessage(e) });
    }
  }

  return (
    <div className="p-8 max-w-xl space-y-8">
      <p className="text-[14px] text-muted-foreground">
        Settings — coming in prompt 5
      </p>

      {/* AWS smoke test */}
      <div className="space-y-3">
        <h2 className="text-[14px] font-medium">AWS CLI</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={runAwsTest}
          disabled={awsTest.status === "running"}
        >
          {awsTest.status === "running" ? "Testing…" : "Test AWS profile list"}
        </Button>
        {awsTest.status !== "idle" && awsTest.status !== "running" && (
          <p
            className={`text-[13px] ${
              awsTest.status === "ok"
                ? "text-green-600 dark:text-green-400"
                : "text-destructive"
            }`}
          >
            {awsTest.detail}
          </p>
        )}
      </div>

      {/* Keychain smoke test */}
      <div className="space-y-3">
        <h2 className="text-[14px] font-medium">macOS Keychain</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={runKeychainTest}
          disabled={kcTest.status === "running"}
        >
          {kcTest.status === "running" ? "Testing…" : "Test Keychain"}
        </Button>
        {kcTest.status !== "idle" && kcTest.status !== "running" && (
          <p
            className={`text-[13px] ${
              kcTest.status === "ok"
                ? "text-green-600 dark:text-green-400"
                : "text-destructive"
            }`}
          >
            {kcTest.detail}
          </p>
        )}
      </div>
    </div>
  );
}
