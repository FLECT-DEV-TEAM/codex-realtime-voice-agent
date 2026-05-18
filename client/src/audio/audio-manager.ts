/**
 * Manages microphone capture and speaker playback through a single
 * AudioWorklet running our `voice-agent-processor` (see
 * `public/audio-worklet.js`).
 *
 * The worklet does both directions of sample-rate conversion locally so
 * mic input wire format is provider-dependent (24 kHz for OpenAI, 16 kHz for
 * Gemini). Playback from the server remains 24 kHz Int16 mono.
 */

export interface AudioManagerCallbacks {
    /** Called with each 20-ms chunk of mic PCM (Int16 LE mono, provider rate). */
    onMicChunk: (chunk: ArrayBuffer) => void;
}

export interface AudioManagerOptions extends AudioManagerCallbacks {
    wireRate?: number;
}

export class AudioManager {
    #ctx: AudioContext | null = null;
    #worklet: AudioWorkletNode | null = null;
    #micStream: MediaStream | null = null;
    #micSource: MediaStreamAudioSourceNode | null = null;
    #callbacks: AudioManagerCallbacks;

    readonly #wireRate: number;

    constructor(callbacks: AudioManagerOptions) {
        this.#callbacks = callbacks;
        this.#wireRate = callbacks.wireRate ?? 24000;
    }

    /** Open mic + speaker. Resolves once the worklet is running. */
    start = async (): Promise<void> => {
        if (this.#ctx) return;
        // Browser default is usually 48 kHz; pin it for predictable
        // resampling math inside the worklet.
        this.#ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
        await this.#ctx.audioWorklet.addModule("/audio-worklet.js");

        this.#worklet = new AudioWorkletNode(this.#ctx, "voice-agent-processor", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            channelCountMode: "explicit",
            channelInterpretation: "speakers",
            processorOptions: { inputWireRate: this.#wireRate },
        });
        this.#worklet.port.onmessage = (ev) => {
            const data = ev.data;
            if (data?.type === "audio" && data.data instanceof ArrayBuffer) {
                this.#callbacks.onMicChunk(data.data);
            }
        };

        // Mic input → worklet
        this.#micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
            video: false,
        });
        this.#micSource = this.#ctx.createMediaStreamSource(this.#micStream);
        this.#micSource.connect(this.#worklet);

        // Worklet → speaker
        this.#worklet.connect(this.#ctx.destination);
    };

    /** Push a chunk of Int16 PCM 24 kHz mono to the playback queue. */
    enqueuePlayback = (pcm: ArrayBuffer): void => {
        if (!this.#worklet) return;
        // postMessage with transfer to avoid copying.
        this.#worklet.port.postMessage({ type: "audio", data: pcm }, [pcm]);
    };

    /** Drop any audio queued for playback (e.g., on barge-in / session stop). */
    flushPlayback = (): void => {
        this.#worklet?.port.postMessage({ type: "flush-output" });
    };

    stop = async (): Promise<void> => {
        try {
            this.#micSource?.disconnect();
        } catch {
            /* ignore */
        }
        try {
            this.#worklet?.disconnect();
        } catch {
            /* ignore */
        }
        if (this.#micStream) {
            this.#micStream.getTracks().forEach((t) => t.stop());
        }
        try {
            await this.#ctx?.close();
        } catch {
            /* ignore */
        }
        this.#ctx = null;
        this.#worklet = null;
        this.#micSource = null;
        this.#micStream = null;
    };
}
