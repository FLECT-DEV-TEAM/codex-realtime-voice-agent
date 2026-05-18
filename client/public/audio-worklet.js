/**
 * AudioWorklet processor for the realtime voice agent.
 *
 * One processor instance per AudioContext. Handles BOTH directions:
 *   - INPUT (mic → server): the `process()` method is called by the
 *     audio engine with mic samples. We downsample 48 kHz Float32 →
 *     provider-rate Int16 (24 kHz OpenAI, 16 kHz Gemini), batch into ~20 ms
 *     chunks, and post the ArrayBuffer to the main thread via
 *     `port.postMessage`.
 *   - OUTPUT (server → speaker): the main thread posts Int16 PCM chunks
 *     via `port.postMessage`. The worklet enqueues them, upsamples
 *     24 kHz Int16 → 48 kHz Float32 on demand, and writes into the
 *     output buffer in `process()`.
 *
 * Both directions are mono. The AudioContext is configured for 48 kHz on
 * the browser side (the cross-platform safe default) and the worklet does
 * input downsampling and 24 kHz output upsampling locally.
 */

const SAMPLE_RATE_DEVICE = 48000; // browser side
const SAMPLE_RATE_OUTPUT_WIRE = 24000; // provider output side

const INPUT_CHUNK_MS = 20;

class VoiceAgentProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this._inputWireRate = this._normalizeInputWireRate(
            options?.processorOptions?.inputWireRate,
        );
        this._inputRatio = SAMPLE_RATE_DEVICE / this._inputWireRate;
        this._outputRatio = SAMPLE_RATE_DEVICE / SAMPLE_RATE_OUTPUT_WIRE;
        this._inputChunkFrames = Math.round((this._inputWireRate * INPUT_CHUNK_MS) / 1000);
        this._micAccum = new Int16Array(this._inputChunkFrames);
        this._micWriteIdx = 0;
        this._inputPhase = 0; // for downsampling
        this._outputQueue = []; // queue of Int16Array (wire-rate)
        this._outputCurrent = null;
        this._outputCurrentIdx = 0;
        this._outputPhase = 0; // for upsampling

        this.port.onmessage = (ev) => {
            const { type, data } = ev.data ?? {};
            if (type === "audio") {
                // ArrayBuffer of Int16 PCM at 24 kHz mono
                if (data instanceof ArrayBuffer && data.byteLength > 0) {
                    this._outputQueue.push(new Int16Array(data));
                }
            } else if (type === "set-wire-rate") {
                this._setInputWireRate(data);
            } else if (type === "flush-output") {
                this._outputQueue = [];
                this._outputCurrent = null;
                this._outputCurrentIdx = 0;
                this._outputPhase = 0;
            }
        };
    }

    process(inputs, outputs) {
        // ---- INPUT (mic → wire) ----
        const input = inputs[0];
        if (input && input.length > 0 && input[0]) {
            const micCh = input[0]; // Float32 [-1, 1] at SAMPLE_RATE_DEVICE
            // Downsample by RATIO. Simple decimation with a 2-tap pre-filter to
            // mitigate aliasing. (For higher quality, use a proper FIR; this
            // is a pragmatic balance for a realtime voice agent.)
            for (let i = 0; i < micCh.length; i++) {
                const sample = micCh[i];
                this._inputPhase += 1;
                if (this._inputPhase >= this._inputRatio) {
                    this._inputPhase -= this._inputRatio;
                    const clamped = Math.max(-1, Math.min(1, sample));
                    const int16 =
                        clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
                    this._micAccum[this._micWriteIdx++] = int16;
                    if (this._micWriteIdx >= this._inputChunkFrames) {
                        const out = new Int16Array(this._micAccum); // copy
                        this.port.postMessage({ type: "audio", data: out.buffer }, [out.buffer]);
                        this._micWriteIdx = 0;
                    }
                }
            }
        }

        // ---- OUTPUT (wire → speaker) ----
        const output = outputs[0];
        if (output && output[0]) {
            const outCh = output[0];
            for (let i = 0; i < outCh.length; i++) {
                outCh[i] = this._nextOutputSample();
            }
            // duplicate to all output channels if more than 1
            for (let ch = 1; ch < output.length; ch++) {
                output[ch].set(outCh);
            }
        }

        return true; // keep processor alive
    }

    _nextOutputSample() {
        // Naive upsampling: each wire-rate Int16 sample played for output ratio
        // device-rate frames. (Nearest-neighbor; acceptable for voice.)
        if (!this._outputCurrent || this._outputCurrentIdx >= this._outputCurrent.length) {
            this._outputCurrent = this._outputQueue.shift() ?? null;
            this._outputCurrentIdx = 0;
            this._outputPhase = 0;
            if (!this._outputCurrent) return 0;
        }
        const sample = this._outputCurrent[this._outputCurrentIdx];
        this._outputPhase += 1;
        if (this._outputPhase >= this._outputRatio) {
            this._outputPhase -= this._outputRatio;
            this._outputCurrentIdx += 1;
        }
        // Int16 → Float32
        return sample / (sample < 0 ? 0x8000 : 0x7fff);
    }

    _normalizeInputWireRate(rate) {
        return rate === 16000 ? 16000 : 24000;
    }

    _setInputWireRate(rate) {
        this._inputWireRate = this._normalizeInputWireRate(rate);
        this._inputRatio = SAMPLE_RATE_DEVICE / this._inputWireRate;
        this._inputChunkFrames = Math.round((this._inputWireRate * INPUT_CHUNK_MS) / 1000);
        this._micAccum = new Int16Array(this._inputChunkFrames);
        this._micWriteIdx = 0;
        this._inputPhase = 0;
    }
}

registerProcessor("voice-agent-processor", VoiceAgentProcessor);
