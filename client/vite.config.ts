import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import mkcert from "vite-plugin-mkcert";

export default defineConfig({
    plugins: [react(), mkcert()],
    server: {
        // 5273 (not Vite's default 5173) so this app's dev server never
        // collides with the throwaway Vite apps Codex spins up in
        // server/workspace (those use the 5173 default). strictPort makes a
        // collision fail loudly instead of silently wandering to 5274+.
        port: 5273,
        strictPort: true,
        // Bind to all interfaces so the dev server is reachable from other
        // devices on the LAN (e.g. a phone). Combined with mkcert this serves
        // HTTPS so getUserMedia (secure-context only) works off-localhost.
        host: true,
        allowedHosts: true,
        proxy: {
            // Browser hits wss://<remote-host>:5273/voice; Vite terminates TLS
            // and forwards as plain ws://127.0.0.1:8787 internally.
            "/voice": {
                target: "ws://127.0.0.1:8787",
                ws: true,
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: "dist",
        sourcemap: true,
    },
});
