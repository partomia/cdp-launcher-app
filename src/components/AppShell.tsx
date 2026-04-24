import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";

const PAGE_TITLES: Record<string, string> = {
  "/": "Dashboard",
  "/install": "New Install",
  "/settings": "Settings",
};

function usePageTitle() {
  const { pathname } = useLocation();
  if (pathname.startsWith("/cluster/")) return "Cluster Detail";
  return PAGE_TITLES[pathname] ?? "CDP Launcher";
}

export function AppShell() {
  const title = usePageTitle();

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar />

      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="flex items-center h-12 px-6 border-b border-border/50 flex-shrink-0">
          <h1 className="text-[18px] font-semibold tracking-tight">{title}</h1>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
