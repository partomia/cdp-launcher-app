import { useEffect } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { LayoutDashboard, PlusCircle, Settings, Sun, Moon } from "lucide-react";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import pkg from "../../package.json";

const NAV_ITEMS = [
  { label: "Dashboard", to: "/", icon: LayoutDashboard, end: true },
  { label: "New Install", to: "/install", icon: PlusCircle, end: false },
  { label: "Settings", to: "/settings", icon: Settings, end: false },
];

export function Sidebar() {
  const { resolvedTheme, setTheme } = useTheme();
  const navigate = useNavigate();

  // Keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!e.metaKey) return;
      if (e.key === "1") {
        e.preventDefault();
        navigate("/");
      }
      if (e.key === "n") {
        e.preventDefault();
        navigate("/install");
      }
      if (e.key === ",") {
        e.preventDefault();
        navigate("/settings");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  function toggleTheme() {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }

  return (
    <aside className="flex h-screen w-60 flex-shrink-0 flex-col bg-muted/40 border-r border-border/50">
      {/* Traffic-light clearance + logo */}
      <div className="flex items-center gap-2.5 px-4 pt-8 pb-5">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-bold select-none">
          CDP
        </div>
        <span className="text-[14px] font-semibold tracking-tight leading-none">
          CDP Launcher
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 space-y-0.5">
        {NAV_ITEMS.map(({ label, to, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-[13px] font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )
            }
          >
            <Icon className="h-4 w-4 flex-shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Footer: theme toggle + version */}
      <div className="flex items-center justify-between px-4 py-4 border-t border-border/40">
        <span className="text-[11px] text-muted-foreground/70 select-none">
          v{pkg.version}
        </span>
        <button
          onClick={toggleTheme}
          className="flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          title={
            resolvedTheme === "dark"
              ? "Switch to light mode"
              : "Switch to dark mode"
          }
        >
          {resolvedTheme === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </button>
      </div>
    </aside>
  );
}
