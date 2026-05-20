import assert from "node:assert/strict";
import test from "node:test";
import { buildApprovalDisplayDetail } from "../src/approval-display-detail.js";
import { getVoiceStrings } from "../src/i18n/voice-strings.js";

const jaLabels = getVoiceStrings("ja").approvalDetail;

test("commandExecution: emits kind + command + cwd, cwd relativised to workspace", () => {
    const out = buildApprovalDisplayDetail({
        kind: "commandExecution",
        params: { command: ["rm", "README.md"], cwd: "/ws/server/workspace" },
        workspace: "/ws/server/workspace",
        labels: jaLabels,
    });
    assert.equal(
        out,
        ["種別: commandExecution", "コマンド: rm README.md", "作業ディレクトリ: ."].join("\n"),
    );
});

test("commandExecution: cwd outside workspace stays absolute", () => {
    const out = buildApprovalDisplayDetail({
        kind: "commandExecution",
        params: { command: "ls", cwd: "/other/dir" },
        workspace: "/ws",
        labels: jaLabels,
    });
    assert.ok(out.includes("作業ディレクトリ: /other/dir"), `unexpected output: ${out}`);
});

test("commandExecution: env-like values redacted in both string and array forms", () => {
    const outString = buildApprovalDisplayDetail({
        kind: "commandExecution",
        params: { command: "FOO_TOKEN=abc rm x", cwd: "/ws" },
        workspace: "/ws",
        labels: jaLabels,
    });
    assert.ok(outString.includes("FOO_TOKEN=<redacted>"));
    assert.ok(!outString.includes("FOO_TOKEN=abc"));

    const outArray = buildApprovalDisplayDetail({
        kind: "commandExecution",
        params: { command: ["FOO_TOKEN=abc", "rm", "x"], cwd: "/ws" },
        workspace: "/ws",
        labels: jaLabels,
    });
    assert.ok(outArray.includes("FOO_TOKEN=<redacted>"));
    assert.ok(!outArray.includes("FOO_TOKEN=abc"));
});

test("fileChange: emits kind + fileTargets list, basenamed and workspace-relative", () => {
    const out = buildApprovalDisplayDetail({
        kind: "fileChange",
        params: {},
        resolvedPaths: ["/ws/src/a.ts", "/ws/src/b.ts"],
        workspace: "/ws",
        labels: jaLabels,
    });
    const lines = out.split("\n");
    assert.equal(lines[0], "種別: fileChange");
    assert.equal(lines[1], "ファイル変更対象:");
    assert.deepEqual(lines.slice(2), ["src/a.ts", "src/b.ts"]);
});

test("fileChange: more than 20 paths collapses tail into … (+N)", () => {
    const paths = Array.from({ length: 23 }, (_, i) => `/ws/p${i}.txt`);
    const out = buildApprovalDisplayDetail({
        kind: "fileChange",
        params: {},
        resolvedPaths: paths,
        workspace: "/ws",
        labels: jaLabels,
    });
    assert.ok(out.includes("… (+3)"), `expected tail summary, got: ${out}`);
});

test("permissions: emits ONLY the kind line, never raw params", () => {
    const out = buildApprovalDisplayDetail({
        kind: "permissions",
        params: { reason: "secret-stuff", token: "abc" },
        workspace: "/ws",
        labels: jaLabels,
    });
    assert.equal(out, "種別: permissions");
    assert.ok(!out.includes("secret-stuff"));
});

test("unknown kind: kind line only (whitelist enforcement)", () => {
    const out = buildApprovalDisplayDetail({
        kind: "weirdKind",
        params: { whatever: 42 },
        workspace: "/ws",
        labels: jaLabels,
    });
    assert.equal(out, "種別: weirdKind");
});

test("defensive cast: null or non-object params do not throw", () => {
    const out1 = buildApprovalDisplayDetail({
        kind: "commandExecution",
        params: null,
        workspace: "/ws",
        labels: jaLabels,
    });
    // Without a command field, only the kind line remains.
    assert.equal(out1, "種別: commandExecution");

    const out2 = buildApprovalDisplayDetail({
        kind: "commandExecution",
        params: "junk",
        workspace: "/ws",
        labels: jaLabels,
    });
    assert.equal(out2, "種別: commandExecution");
});

test("document cap appends [truncated] when over the 2000-char limit", () => {
    // 30 paths each 100 chars deep → comfortably over 2000 chars total once
    // labels and newlines are included.
    const paths = Array.from({ length: 30 }, (_, i) => `/ws/${"x".repeat(100)}-${i}.txt`);
    const out = buildApprovalDisplayDetail({
        kind: "fileChange",
        params: {},
        resolvedPaths: paths,
        workspace: "/ws",
        labels: jaLabels,
    });
    assert.ok(
        out.endsWith("\n[truncated]"),
        `expected truncated marker, last 30 chars: ${out.slice(-30)}`,
    );
    assert.ok(out.length <= 2000);
});

test("english labels: shape matches ja but body uses en strings", () => {
    const enLabels = getVoiceStrings("en").approvalDetail;
    const out = buildApprovalDisplayDetail({
        kind: "commandExecution",
        params: { command: "ls", cwd: "/ws" },
        workspace: "/ws",
        labels: enLabels,
    });
    assert.ok(out.startsWith("Kind: commandExecution"), out);
    assert.ok(out.includes("Command: ls"));
    assert.ok(out.includes("Working directory: ."));
});
