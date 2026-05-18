/**
 * JSON Lines session logger. One file per session, plus a `latest.jsonl`
 * symlink for quick `tail -f`.
 *
 * Convention:
 *   - One line = one JSON object: { t, src, ev, data? }
 *   - `t` is ISO timestamp (UTC).
 *   - `src` is the subsystem (e.g. "rt.out", "rt.in", "session", "bridge",
 *     "voice", "policy").
 *   - `ev` is a short event name (e.g. the Realtime API event type, or a
 *     symbolic name like "state-change").
 *   - `data` is an optional payload (already summarised — audio buffers
 *     are replaced with byte counts so the file stays grep-friendly).
 *
 * The log is intended as a debugging aid. It is NOT a structured audit
 * trail and the schema is allowed to evolve.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface LogEntry {
    t: string;
    src: string;
    ev: string;
    data?: unknown;
}

export class SessionLogger {
    /** Filename basename without extension — acts as a human-readable session id. */
    readonly id: string;
    readonly file: string;
    #stream: fs.WriteStream | null;

    constructor(logsDir: string) {
        fs.mkdirSync(logsDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        this.id = `session-${ts}`;
        this.file = path.join(logsDir, `${this.id}.jsonl`);
        this.#stream = fs.createWriteStream(this.file, { flags: "a" });
        // Best-effort: keep latest.jsonl pointing at the current session so
        // `tail -f server/logs/latest.jsonl` always shows the live stream.
        const latest = path.join(logsDir, "latest.jsonl");
        try {
            if (fs.existsSync(latest) || fs.lstatSync(latest).isSymbolicLink())
                fs.unlinkSync(latest);
        } catch {
            /* ignore */
        }
        try {
            fs.symlinkSync(path.basename(this.file), latest);
        } catch {
            /* ignore (e.g. on filesystems without symlink support) */
        }
    }

    log = (src: string, ev: string, data?: unknown): void => {
        if (!this.#stream) return;
        const entry: LogEntry = { t: new Date().toISOString(), src, ev };
        if (data !== undefined) entry.data = data;
        this.#stream.write(JSON.stringify(entry) + "\n");
    };

    close = (): void => {
        this.#stream?.end();
        this.#stream = null;
    };
}
