/**
 * WebSocket client for the realtime voice agent.
 *
 * Single-purpose connection that multiplexes:
 *   - Binary frames = raw PCM int16 LE 24 kHz mono audio.
 *   - Text frames   = JSON messages, see `../types/messages`.
 */
import type { ClientToServerMessage, ServerToClientMessage } from "../types/messages.js";

export interface VoiceWsCallbacks {
    onMessage: (msg: ServerToClientMessage) => void;
    onAudio: (pcm: ArrayBuffer) => void;
    onOpen: () => void;
    onClose: (code: number, reason: string) => void;
    onError: (err: Event) => void;
}

export class VoiceWsClient {
    #ws: WebSocket | null = null;
    #callbacks: VoiceWsCallbacks;

    constructor(callbacks: VoiceWsCallbacks) {
        this.#callbacks = callbacks;
    }

    connect = (url: string): void => {
        this.#ws = new WebSocket(url);
        this.#ws.binaryType = "arraybuffer";
        this.#ws.onopen = () => this.#callbacks.onOpen();
        this.#ws.onmessage = (ev) => {
            if (typeof ev.data === "string") {
                try {
                    const parsed = JSON.parse(ev.data) as ServerToClientMessage;
                    this.#callbacks.onMessage(parsed);
                } catch {
                    /* ignore malformed */
                }
            } else if (ev.data instanceof ArrayBuffer) {
                this.#callbacks.onAudio(ev.data);
            }
        };
        this.#ws.onerror = (ev) => this.#callbacks.onError(ev);
        this.#ws.onclose = (ev) => this.#callbacks.onClose(ev.code, ev.reason);
    };

    close = (): void => {
        try {
            this.#ws?.close();
        } catch {
            /* ignore */
        }
        this.#ws = null;
    };

    send = (msg: ClientToServerMessage): void => {
        if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
        this.#ws.send(JSON.stringify(msg));
    };

    sendAudio = (pcm: ArrayBuffer): void => {
        if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
        this.#ws.send(pcm);
    };

    get isOpen(): boolean {
        return this.#ws?.readyState === WebSocket.OPEN;
    }
}
