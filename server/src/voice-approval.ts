/**
 * Voice-only approval escalation coordinator.
 *
 * Design (fully deterministic, application-driven):
 *
 *   1. Codex emits an approval-requested; the deterministic policy
 *      classifies it as "escalate".
 *   2. `escalate()` switches server VAD into the escalation profile
 *      (`create_response:false` + `interrupt_response:false`): VAD still
 *      detects speech and produces transcripts, but it never spawns a
 *      competing chit-chat response and never auto-interrupts. From here
 *      until the escalation resolves, EVERY response.create /
 *      response.cancel is issued by this coordinator — so the approval
 *      question can never be mixed with a VAD-spawned reply.
 *   3. Phase `notice`: speak a short "Codex から問い合わせが来ました" out
 *      of band. On its `response.done`, phase `question`: speak the actual
 *      approval content + "はい か いいえ で答えてください".
 *   4. The host (session.ts) classifies the user's spoken answer straight
 *      off the transcript and calls one of `accept()` / `refuse()` /
 *      `clarify()` / `ambiguous()`. The model is NEVER asked to classify —
 *      there is no `voice_approval_response` tool anymore.
 *        - accept / refuse  → interrupt any in-flight approval TTS, restore
 *          VAD, resolve the escalation immediately (so Codex proceeds with
 *          no extra latency), then speak "承認しました" / "却下しました".
 *        - clarify(q)       → answer the question in one short sentence and
 *          re-ask. Bounded by {@link MAX_CLARIFY}.
 *        - ambiguous()      → "すみません、はい か いいえ でお願いします".
 *          Bounded independently by {@link MAX_AMBIGUOUS}.
 *      Exceeding either bound refuses as a safe terminal.
 *
 * Interruption is application-driven: the coordinator asks the host to
 * cancel the in-flight response, flush the browser playback queue and
 * truncate the spoken item via the `onInterrupt` callback. This replaces
 * the old VAD-driven barge-in for the escalation window.
 */
import {
    DEFAULT_TURN_DETECTION,
    ESCALATION_TURN_DETECTION,
} from "./providers/openai-realtime-provider.js";
import type { VoiceProvider } from "./providers/voice-provider.js";
import type { VoiceStrings } from "./i18n/voice-strings.js";

export type VoiceDecision = "accept" | "refuse";

/** Max number of genuine user-question clarification rounds before the
 *  escalation refuses as a safe terminal. */
const MAX_CLARIFY = 3;
/** Max number of ambiguous-utterance re-prompts (back-channel / noise /
 *  silence). Counted independently of {@link MAX_CLARIFY} so a user asking
 *  real questions is not penalised by mic echo, and an echo loop still
 *  terminates finitely. */
const MAX_AMBIGUOUS = 3;

type Phase = "idle" | "notice" | "question" | "clarifying" | "reprompt" | "finalizing";

interface PendingEscalation {
    resolve: (d: VoiceDecision) => void;
    reject: (err: Error) => void;
    summary: string;
    detail?: string;
}

export interface VoiceApprovalHost {
    /** Stop whatever is currently being spoken: cancel the in-flight
     *  response, flush the browser playback queue, truncate the active
     *  assistant item, and resolve once the response is idle. Must be safe
     *  to call (and resolve promptly) when nothing is in flight. */
    onInterrupt: () => Promise<void>;
}

export class VoiceApprovalCoordinator {
    #pending: PendingEscalation | null = null;
    #phase: Phase = "idle";
    #clarifyCount = 0;
    #ambiguousCount = 0;
    /** Serialises every spoken step (notice / clarify / reprompt / outcome).
     *  Each step is `interrupt → guarded response.create`; without this
     *  chain two user utterances in quick succession could each enqueue a
     *  response.create whose out-of-band responses then overlap — exactly
     *  the bug this whole rework exists to kill. Kept on a never-rejecting
     *  promise so one failing step does not stall the rest. */
    #speakChain: Promise<void> = Promise.resolve();
    readonly #realtime: VoiceProvider;
    readonly #host: VoiceApprovalHost;
    readonly #strings: VoiceStrings;

    constructor(realtime: VoiceProvider, host: VoiceApprovalHost, strings: VoiceStrings) {
        this.#realtime = realtime;
        this.#host = host;
        this.#strings = strings;
        // The ONLY responseDone-driven transition: once the (un-interrupted)
        // notice finishes, speak the actual question. Everything else
        // (clarify / reprompt / finalize) interrupts the in-flight response
        // explicitly and is sequenced imperatively, so it must NOT also be
        // driven from here — those methods set `#phase` away from "notice"
        // *before* triggering the cancel, so the cancelled response's
        // response.done lands here as a harmless no-op.
        realtime.on("responseDone", () => {
            if (!this.#pending) {
                this.#phase = "idle";
                return;
            }
            if (this.#phase === "notice") {
                this.#phase = "question";
                this.#speakQuestion();
            }
        });
    }

    /** Append a spoken step to the serial chain. */
    #enqueueSpeak = (fn: () => Promise<void>): void => {
        const next = this.#speakChain.then(fn, fn);
        this.#speakChain = next.then(
            () => undefined,
            () => undefined,
        );
    };

    get isEscalating(): boolean {
        return this.#pending !== null;
    }

    get pendingSummary(): string | null {
        return this.#pending?.summary ?? null;
    }

    escalate = (summary: string, detail?: string): Promise<VoiceDecision> => {
        if (this.#pending) {
            throw new Error(
                "voice approval already in flight — concurrent escalation is not supported",
            );
        }
        const promise = new Promise<VoiceDecision>((resolve, reject) => {
            this.#pending = { resolve, reject, summary, detail };
        });
        this.#phase = "notice";
        this.#clarifyCount = 0;
        this.#ambiguousCount = 0;
        // VAD: detect speech (transcripts keep flowing) but never auto-
        // create or auto-interrupt a response while we own the floor.
        this.#realtime.updateSession({ turnDetection: ESCALATION_TURN_DETECTION });
        this.#enqueueSpeak(this.#startNotice);
        return promise;
    };

    /** Clear the floor (stop any leftover speech — e.g. a previous
     *  escalation's cosmetic "承認しました", or a normal agent response)
     *  then speak the heads-up. */
    #startNotice = async (): Promise<void> => {
        await this.#host.onInterrupt();
        if (!this.#pending || this.#phase !== "notice") return;
        this.#speakNotice();
    };

    /** Phase 1: a short, fixed heads-up. Kept separate from the content so
     *  the user gets an unmistakable "stop and listen" cue. */
    #speakNotice = (): void => {
        this.#realtime.createResponse({
            conversation: "none",
            toolChoice: "none",
            instructions: this.#strings.approval.notice.instructions,
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: this.#strings.approval.notice.spokenInput,
                        },
                    ],
                },
            ],
        });
    };

    /** Phase 2: summarise the actual approval request and ask yes/no. */
    #speakQuestion = (): void => {
        if (!this.#pending) return;
        const { summary } = this.#pending;
        this.#realtime.createResponse({
            conversation: "none",
            toolChoice: "none",
            instructions: this.#strings.approval.question.instructions,
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: this.#strings.approval.question.spokenInput(summary),
                        },
                    ],
                },
            ],
        });
    };

    /** The user clearly agreed. */
    accept = (): void => {
        this.#finalize("accept", this.#strings.outcomes.accepted);
    };

    /** The user clearly declined. */
    refuse = (): void => {
        this.#finalize("refuse", this.#strings.outcomes.refused);
    };

    /** The user asked a genuine question before deciding. Answer it in one
     *  short sentence and re-ask; bounded by {@link MAX_CLARIFY}. */
    clarify = (question: string): void => {
        if (!this.#pending) return;
        this.#clarifyCount += 1;
        if (this.#clarifyCount > MAX_CLARIFY) {
            this.#finalize("refuse", this.#strings.outcomes.refusedUnconfirmed);
            return;
        }
        const q = question.trim() || this.#strings.approval.clarify.defaultQuestion;
        const detail = this.#pending.detail ?? this.#pending.summary;
        this.#phase = "clarifying";
        this.#enqueueSpeak(() => this.#doClarify(q, detail));
    };

    #doClarify = async (q: string, detail: string): Promise<void> => {
        await this.#host.onInterrupt();
        if (!this.#pending || this.#phase !== "clarifying") return;
        this.#realtime.createResponse({
            conversation: "none",
            toolChoice: "none",
            instructions: this.#strings.approval.clarify.instructions(q),
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: this.#strings.approval.clarify.spokenInput(detail, q),
                        },
                    ],
                },
            ],
        });
    };

    /** The latest utterance was neither a clear yes/no nor a real question
     *  (back-channel, noise, silence). Re-prompt; bounded independently by
     *  {@link MAX_AMBIGUOUS}. */
    ambiguous = (): void => {
        if (!this.#pending) return;
        this.#ambiguousCount += 1;
        if (this.#ambiguousCount > MAX_AMBIGUOUS) {
            this.#finalize("refuse", this.#strings.outcomes.refusedUnconfirmed);
            return;
        }
        this.#phase = "reprompt";
        this.#enqueueSpeak(this.#doAmbiguous);
    };

    #doAmbiguous = async (): Promise<void> => {
        await this.#host.onInterrupt();
        if (!this.#pending || this.#phase !== "reprompt") return;
        this.#realtime.createResponse({
            conversation: "none",
            toolChoice: "none",
            instructions: this.#strings.approval.ambiguous.instructions,
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: this.#strings.approval.ambiguous.spokenInput,
                        },
                    ],
                },
            ],
        });
    };

    abort = (reason: string): void => {
        if (!this.#pending) return;
        const p = this.#pending;
        this.#pending = null;
        this.#phase = "idle";
        this.#realtime.updateSession({ turnDetection: DEFAULT_TURN_DETECTION });
        p.reject(new Error(reason));
    };

    /** Resolve the escalation and speak a short confirmation. The decision
     *  is returned to Codex *before* the confirmation audio so Codex never
     *  waits on cosmetic TTS. The confirmation is spoken out of band with
     *  VAD already restored (out-of-band responses are unaffected by it). */
    #finalize = (decision: VoiceDecision, spoken: string): void => {
        if (!this.#pending) return;
        const p = this.#pending;
        this.#pending = null;
        this.#phase = "finalizing";
        this.#realtime.updateSession({ turnDetection: DEFAULT_TURN_DETECTION });
        // Return the decision to Codex *now* — it must never wait on the
        // cosmetic confirmation TTS.
        p.resolve(decision);
        this.#enqueueSpeak(() => this.#speakOutcome(spoken));
    };

    /** Stop any in-flight approval TTS (notice / question / clarify),
     *  wait for the response to go idle, then speak the short confirmation
     *  out of band (VAD is already restored; out-of-band is unaffected). */
    #speakOutcome = async (spoken: string): Promise<void> => {
        await this.#host.onInterrupt();
        this.#realtime.createResponse({
            conversation: "none",
            toolChoice: "none",
            instructions: this.#strings.approval.outcome.instructions,
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: this.#strings.approval.outcome.spokenInput(spoken),
                        },
                    ],
                },
            ],
        });
    };
}
