import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import Dashboard from "./pages/Dashboard";
import InstallWizard from "./pages/InstallWizard";
import ClusterDetail from "./pages/ClusterDetail";
import Settings from "./pages/Settings";
import { licenseCheck } from "./lib/tauri";

// ---------------------------------------------------------------------------
// License gate wrapper
// ---------------------------------------------------------------------------

function LicenseGate({ children }: { children: React.ReactNode }) {
  const [checked, setChecked] = useState(false);
  const [valid, setValid] = useState(false);

  useEffect(() => {
    licenseCheck()
      .then((ok) => {
        setValid(ok);
        setChecked(true);
      })
      .catch(() => {
        setValid(false);
        setChecked(true);
      });
  }, []);

  if (!checked) {
    return (
      <div className="flex items-center justify-center h-screen text-[13px] text-muted-foreground">
        Checking license…
      </div>
    );
  }

  if (!valid) {
    // Redirect to Settings so the user can activate a license.
    // We still allow the Settings page to render inside AppShell.
    return <Navigate to="/settings" replace />;
  }

  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route
            index
            element={
              <LicenseGate>
                <Dashboard />
              </LicenseGate>
            }
          />
          <Route
            path="/install"
            element={
              <LicenseGate>
                <InstallWizard />
              </LicenseGate>
            }
          />
          <Route
            path="/cluster/:id"
            element={
              <LicenseGate>
                <ClusterDetail />
              </LicenseGate>
            }
          />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
