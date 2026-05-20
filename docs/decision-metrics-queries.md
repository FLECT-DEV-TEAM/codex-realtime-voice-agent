# Decision Metrics Queries

この文書は運用/分析資料です。自動テスト対象外です。

`approval-utterance` ログは `server/logs/*.jsonl` に JSON Lines として出力されます。以下の例では対象ログを `server/logs/*.jsonl` として扱います。

## ログフィールド

- `t`: ISO timestamp
- `src`: subsystem。対象イベントでは `"voice"`
- `ev`: event name。対象イベントでは `"approval-utterance"`
- `data.text`: 判定対象の発話テキスト
- `data.kind`: 判定結果。`"accept"`, `"refuse"`, `"question"`, `"ambiguous"`
- `data.lang`: session start 時の会話言語 snapshot
- `data.transcriptionLanguage`: session start 時の transcription language snapshot
- `data.textLength`: JavaScript string length。UTF-16 code unit 数で、改行や句読点も含みます。byte 数や grapheme cluster 数ではありません。

## jq クエリ

全体 verdict 分布:

```sh
jq -r 'select(.src == "voice" and .ev == "approval-utterance") | .data.kind' server/logs/*.jsonl \
  | sort \
  | uniq -c \
  | sort -nr
```

`transcriptionLanguage` 別 null 経路率:

```sh
# null 経路 = question + ambiguous
jq -r '
  select(.src == "voice" and .ev == "approval-utterance")
  | [.data.transcriptionLanguage, .data.kind]
  | @tsv
' server/logs/*.jsonl \
  | awk -F "\t" '
      { total[$1] += 1; if ($2 == "ambiguous" || $2 == "question") null_path[$1] += 1 }
      END {
        for (lang in total) {
          printf "%s\tnull_path=%d/%d\t%.2f%%\n", lang, null_path[lang], total[lang], null_path[lang] * 100 / total[lang]
        }
      }
    ' \
  | sort
```

`kind=ambiguous` の text 抽出:

```sh
jq -r '
  select(.src == "voice" and .ev == "approval-utterance" and .data.kind == "ambiguous")
  | [.t, .data.lang, .data.transcriptionLanguage, .data.textLength, .data.text]
  | @tsv
' server/logs/*.jsonl
```

会話言語と transcription language の組み合わせ別 verdict 分布:

```sh
jq -r '
  select(.src == "voice" and .ev == "approval-utterance")
  | [.data.lang, .data.transcriptionLanguage, .data.kind]
  | @tsv
' server/logs/*.jsonl \
  | sort \
  | uniq -c \
  | sort -nr
```

## プライバシー方針

- 本メトリクスは既存の γ 方針を踏襲します。
- `server/logs/` は gitignore 済みで、通常のソース管理対象にはしません。
- ログを共有する場合は `data.text` などの発話内容を sanitize してください。
- retention は別途運用判断とし、この文書では保存期間を定義しません。
