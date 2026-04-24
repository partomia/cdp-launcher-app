import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Tauri expects a fixed port and no file protocol
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Prevent Vite from watching Rust files
      ignored: ["**/src-tauri/**"],
    },
  },
}));
