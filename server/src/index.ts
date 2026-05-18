/**
 * Server entry point: Express app + WebSocket endpoint.
 *
 * Single-tab assumption: only one `Session` is active at a time. A second
 * concurrent client is accepted but its `session/start` will fail until the
 * first session is closed. (Single-user local-only design.)
 */
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket as WS } from "ws";
import { Session } from "./session.js";

const __filename = fileURLToPath(import.meta.url);
const SERVER_DIR = path.resolve(path.dirname(__filename), "..");
const DEFAULT_CODEX_CWD = path.join(SERVER_DIR, "workspace");
const LOGS_DIR = path.join(SERVER_DIR, "logs");

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
    console.error("OPENAI_API_KEY is not set. Copy .env.example to .env and set the key.");
    process.exit(1);
}

const defaultModel = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2";
const defaultVoice = process.env.OPENAI_REALTIME_VOICE ?? "marin";
const defaultGeminiModel = process.env.GEMINI_LIVE_MODEL ?? "gemini-3.1-flash-live-preview";
const geminiApiKey = process.env.GEMINI_API_KEY;
const port = Number(process.env.SERVER_PORT ?? 8787);
const codexCwd = process.env.CODEX_CWD ? path.resolve(process.env.CODEX_CWD) : DEFAULT_CODEX_CWD;

if (!fs.existsSync(codexCwd)) fs.mkdirSync(codexCwd, { recursive: true });

console.error(`[boot] port=${port} codex_cwd=${codexCwd}`);
console.error(`[boot] default model=${defaultModel} voice=${defaultVoice}`);
console.error(`[boot] default gemini model=${defaultGeminiModel}`);
console.error(`[boot] logs_dir=${LOGS_DIR}`);

const app = express();
app.get("/healthz", (_req, res) => {
    res.status(200).type("text/plain").send("ok");
});

const httpServer = app.listen(port, () => {
    console.error(`[boot] HTTP listening on http://127.0.0.1:${port}`);
});

const wss = new WebSocketServer({ server: httpServer, path: "/voice" });
let activeSession: Session | null = null;

wss.on("connection", (ws: WS) => {
    if (activeSession) {
        console.error("[server] new client connected, replacing previous session");
        void activeSession.stop();
        activeSession = null;
    }
    console.error("[server] client connected");
    const session = new Session(
        {
            apiKey,
            geminiApiKey,
            defaultModel,
            defaultVoice,
            defaultGeminiModel,
            codexCwd,
            logsDir: LOGS_DIR,
        },
        ws,
    );
    activeSession = session;
    ws.on("close", () => {
        if (activeSession === session) activeSession = null;
        console.error("[server] client disconnected");
    });
});

const shutdown = async (): Promise<void> => {
    console.error("[server] shutting down");
    if (activeSession) {
        await activeSession.stop();
        activeSession = null;
    }
    wss.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
