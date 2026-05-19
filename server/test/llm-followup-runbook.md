# U5 Manual Runbook: auto LLM Language Follow-up

Use this runbook when automated Realtime/Gemini API verification is not available in the test environment.

## Prerequisites

- Server can run with either `OPENAI_API_KEY` for OpenAI Realtime or `GEMINI_API_KEY` for Gemini Live.
- Browser microphone access is available.
- Session setting `transcriptionLanguage` is empty (`auto`) or one of `ko`, `zh`, `es`, `fr`, `de` so the server normalizes the conversation language to `auto`.
- `instructionsExtra` is empty for the baseline run.

## Steps

1. Start the app with the selected provider.
2. Open the client and start a voice session.
3. Ask a normal non-approval coding question in English, for example: "What files are in this project?"
4. Confirm the spoken assistant response is in English.
5. Stop the session, start a new `auto` session, and ask a normal non-approval question in Japanese, for example: "このプロジェクトの構成を教えて。"
6. Confirm the spoken assistant response is in Japanese.
7. Repeat with one fallback language if the STT/provider setup supports it, for example Spanish: "Que archivos hay en este proyecto?"
8. Trigger a Codex approval request if possible and confirm that the approval prompt uses the language bundle selected for the session (`auto` uses the language-neutral/English fallback bundle).

## Pass Criteria

- In `auto`, ordinary assistant replies follow the language the user spoke for English and Japanese.
- No approval prompt reads raw commands or full paths aloud.
- Approval yes/no prompts remain deterministic and do not depend on `instructionsExtra`.
- If a fallback language is tested, the ordinary assistant reply should follow that user language. A provider/STT limitation should be recorded, not silently passed.

## Record

| Date | Provider | Model | Session language setting | User utterance | Observed response language | Pass/Fail | Notes |
| ---- | -------- | ----- | ------------------------ | -------------- | -------------------------- | --------- | ----- |
|      |          |       | auto                     |                |                            |           |       |

## 実行結果記録

- Date: 2026-05-19
- Environment: current automated test environment
- Result: Real API verification was not reachable because `OPENAI_API_KEY` and `GEMINI_API_KEY` were not set.
- Substitute verification: `server/test/voice-strings.test.ts` passed the static `buildSystemInstructions("auto")` assertion that the auto bundle tells the model to reply in the language the user is speaking, and verifies the shared Codex progress token.
