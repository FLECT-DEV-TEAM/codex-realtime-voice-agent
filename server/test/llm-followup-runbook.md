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
| 2026-05-20 | OpenAI | gpt-realtime-2 | auto | "What files are in this project?" | English | Pass | Case 1: en 発話 → en 応答 |
| 2026-05-20 | OpenAI | gpt-realtime-2 | auto | 「このプロジェクトの構成を教えて?」 | Japanese | Pass | Case 2: ja 発話 → ja 応答 |
| 2026-05-20 | OpenAI | gpt-realtime-2 | es (→auto) | "Que achegos ei a neste proxecto?" | Spanish | Pass | Case 3: STT に認識ゆれあり (Galician 混じり) も agent はスペイン語応答 |
| 2026-05-20 | OpenAI | gpt-realtime-2 | ja | 「README を削除して」 (ja 発話) → 「はい」 | ja approval prompt → 承認しました | Pass | Case 4-A: ja 束で accept 決定的・raw command 非読上 |
| 2026-05-20 | OpenAI | gpt-realtime-2 | ja | "delete the readme" (en 発話) → 「いいえ」 | ja approval prompt → 却下しました | Pass | **Case 4-B: 束ロック検証** — en 発話でも prompt は ja・refuse 決定的 |
| 2026-05-20 | OpenAI | gpt-realtime-2 | en | 「リードミーファイルを削除して?」 (ja 発話) → "No" | en approval prompt → Declined | Pass | **Case 4-C: en 束対称性** — ja 発話でも prompt は en・"No" 決定的 |
| 2026-05-20 | OpenAI | gpt-realtime-2 | auto | (en/zh mixed) 「リードミー消して。」 (ja 発話) | en approval prompt (autoStrings=en ベース) | Pass | **Case 4-D**: 通常会話はユーザー言語追従、承認フローは束ロック (autoStrings の systemInstructions と束ロックが同セッション内で両立) |

## 実行結果記録

- Date: 2026-05-19
- Environment: i18n 実装時の自動テスト環境
- Result: Real API verification was not reachable because `OPENAI_API_KEY` and `GEMINI_API_KEY` were not set.
- Substitute verification: `server/test/voice-strings.test.ts` passed the static `buildSystemInstructions("auto")` assertion that the auto bundle tells the model to reply in the language the user is speaking, and verifies the shared Codex progress token.

### 2026-05-20 実機検証 (完全 PASS)

- Date: 2026-05-20
- Environment: developer local, `.env` に `OPENAI_API_KEY` 設定済み, Provider=OpenAI Realtime, Model=gpt-realtime-2
- Result: **U5 マトリクス全項目 PASS** (上記 Record の 7 行参照)
  - Case 1-3: auto 経路の LLM 言語追従 (en/ja/es)
  - Case 4-A: ja 束で accept 決定的
  - Case 4-B: **束ロック検証** — ja 会話言語 session に en 発話で削除依頼しても prompt は ja で発火
  - Case 4-C: en 束で refuse 決定的 — ja 発話でも prompt は en で発火 (対称性)
  - Case 4-D: auto 束 — 通常会話はユーザー言語追従、承認フローは束ロック (同セッション内で両立)
- Safety design 遵守: いずれのケースでも承認 summary が raw command やフルパスを読み上げないこと、`[approval]` 行は `summarize.commandExec` テンプレート ("コマンド実行の承認依頼です。詳細は確認画面に表示します。" / "Codex is asking to run a command. The full command is shown in the details.") のみで raw 文字列は detail 側に退避されていることを確認。
- 結果として spec の **AC-15 / OQ-1 / 案1 reactive** の人手検証が完了。残課題から U5 を消し込み可。
