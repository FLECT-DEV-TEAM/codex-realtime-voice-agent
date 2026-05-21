import assert from "node:assert/strict";
import test from "node:test";
import {
    analyzeCommand,
    capDocument,
    capLine,
    displayCommand,
    displayPath,
    escapeControl,
    extractCommandTokens,
    isInsideWorkspace,
    redact,
} from "../src/approval-sanitize.js";

test("redact masks env-like assignments and leaves lowercase keys alone", () => {
    assert.equal(redact("FOO_TOKEN=abc rm x"), "FOO_TOKEN=<redacted> rm x");
    assert.equal(redact("token=abc rm x"), "token=abc rm x");
    assert.equal(redact(";FOO_TOKEN=abc"), ";FOO_TOKEN=<redacted>");
});

test("redact handles quoted, escaped, empty, and backslash-bearing values", () => {
    assert.equal(redact(`TOKEN="abc def" rm x`), "TOKEN=<redacted> rm x");
    assert.equal(redact(`TOKEN='abc def' rm x`), "TOKEN=<redacted> rm x");
    assert.equal(redact(`TOKEN=""`), "TOKEN=<redacted>");
    assert.equal(redact(`TOKEN="C:\\Users\\me" rm x`), "TOKEN=<redacted> rm x");
    assert.equal(redact(`TOKEN="abc \\" def" rm x`), "TOKEN=<redacted> rm x");
});

test("redact: unmatched-quote partial-leak is the documented allowance", () => {
    // Single token with no trailing whitespace: bare branch still wipes everything.
    assert.equal(redact(`TOKEN="abc`), "TOKEN=<redacted>");
    // Whitespace-tailed broken input: the bare branch only matches up to the
    // next space, so " def" survives. Treated as acceptable for malformed
    // input per spec §7.5.2.
    assert.equal(redact(`TOKEN="abc def`), "TOKEN=<redacted> def");
});

test("redact is idempotent", () => {
    const once = redact("FOO_TOKEN=abc");
    assert.equal(redact(once), once);
});

test("escapeControl normalises tabs/CR and strips other C0 / DEL", () => {
    assert.equal(escapeControl("a\tb\rc"), "a b c");
    assert.equal(escapeControl("a\nb"), "a\nb"); // \n preserved at the helper layer
    assert.equal(escapeControl("a\x00b\x1fc\x7fd"), "abcd");
});

test("isInsideWorkspace handles equal, descendant, and outside paths", () => {
    assert.equal(isInsideWorkspace("/ws", "/ws"), true);
    assert.equal(isInsideWorkspace("/ws/sub/a.txt", "/ws"), true);
    assert.equal(isInsideWorkspace("/other/a.txt", "/ws"), false);
    assert.equal(isInsideWorkspace("/ws/../escape", "/ws"), false);
});

test("capLine returns input untouched when short, else mid-elides", () => {
    assert.equal(capLine("short", 10), "short");
    const long = "0123456789".repeat(10); // 100 chars
    const out = capLine(long, 20);
    assert.equal(out.length, 20);
    assert.ok(out.includes("…"), "expected ellipsis marker");
    assert.ok(out.startsWith("0"), "head preserved");
    assert.ok(out.endsWith("9"), "tail preserved");
});

test("capDocument adds [truncated] only when over the 2000 char limit", () => {
    assert.equal(capDocument("short"), "short");
    const blob = "x".repeat(2500);
    const out = capDocument(blob);
    assert.ok(out.endsWith("\n[truncated]"), "expected truncated marker at end");
    assert.equal(out.length, 2000);
});

test("displayPath uses workspace-relative inside and absolute (or ~) outside", () => {
    assert.equal(displayPath("/ws/sub/a.txt", "/ws"), "sub/a.txt");
    assert.equal(displayPath("/ws", "/ws"), ".");
    assert.equal(displayPath("/other/a.txt", "/ws"), "/other/a.txt");

    const prevHome = process.env.HOME;
    process.env.HOME = "/home/u";
    try {
        assert.equal(displayPath("/home/u/x", "/ws"), "~/x");
        assert.equal(displayPath("/home/u", "/ws"), "~");
    } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
    }
});

test("displayCommand handles string and array input with quoting / escapes", () => {
    assert.equal(displayCommand("rm README.md"), "rm README.md");
    assert.equal(displayCommand(["rm", "a b.txt"]), 'rm "a b.txt"');
    assert.equal(displayCommand(["echo", 'she said "hi"']), 'echo "she said \\"hi\\""');
    assert.equal(displayCommand(["echo", "C:\\Users\\me"]), 'echo "C:\\\\Users\\\\me"');
});

test("displayCommand quoting boundary cases (v5 should-3)", () => {
    assert.equal(displayCommand([""]), '""');
    assert.equal(displayCommand(['"']), '"\\""');
    assert.equal(displayCommand(["\\"]), '"\\\\"');
    assert.equal(displayCommand(['""']), '"\\"\\""');
});

test("displayCommand redacts env-like assignments inside the body", () => {
    assert.equal(displayCommand("FOO_TOKEN=abc rm x"), "FOO_TOKEN=<redacted> rm x");
});

// extractCommandTokens — fully covers spec §7.5.6 case table.
test("extractCommandTokens: simple cases", () => {
    assert.deepEqual(extractCommandTokens("rm README.md"), ["rm", "README.md"]);
    assert.deepEqual(extractCommandTokens(["rm", "README.md"]), ["rm", "README.md"]);
});

test("extractCommandTokens: 4-token-exact yields no sentinel", () => {
    assert.deepEqual(extractCommandTokens("git push origin main"), [
        "git",
        "push",
        "origin",
        "main",
    ]);
    assert.deepEqual(extractCommandTokens(["git", "push", "origin", "main"]), [
        "git",
        "push",
        "origin",
        "main",
    ]);
});

test("extractCommandTokens: path-like args are basenamed", () => {
    assert.deepEqual(extractCommandTokens("rm -rf /path/to/dir"), ["rm", "-rf", "dir"]);
    assert.deepEqual(extractCommandTokens(["rm", "-rf", "/path/to/dir"]), ["rm", "-rf", "dir"]);
    assert.deepEqual(extractCommandTokens("sudo rm /tmp/x"), ["sudo", "rm", "x"]);
});

test("extractCommandTokens: 5-input adds the … sentinel", () => {
    assert.deepEqual(extractCommandTokens("./script.sh a b c d"), [
        "script.sh",
        "a",
        "b",
        "c",
        "…",
    ]);
    assert.deepEqual(extractCommandTokens("a b c d e f"), ["a", "b", "c", "d", "…"]);
});

test("extractCommandTokens: separator tokens truncate", () => {
    assert.deepEqual(extractCommandTokens("rm a.txt | grep foo"), ["rm", "a.txt"]);
    assert.deepEqual(extractCommandTokens("cat in > out.txt"), ["cat", "in"]);
    assert.deepEqual(extractCommandTokens("cmd 2> err.log"), ["cmd"]);
    assert.deepEqual(extractCommandTokens("cmd <<< input"), ["cmd"]);
    assert.deepEqual(extractCommandTokens("cmd && other"), ["cmd"]);
});

test("extractCommandTokens: embedded separators are NOT split", () => {
    assert.deepEqual(extractCommandTokens("cmd;cmd2"), ["cmd;cmd2"]);
});

test("extractCommandTokens: redaction applies to summary tokens", () => {
    assert.deepEqual(extractCommandTokens("FOO_TOKEN=abc rm x"), [
        "FOO_TOKEN=<redacted>",
        "rm",
        "x",
    ]);
    assert.deepEqual(extractCommandTokens('TOKEN="abc def" rm x'), ["TOKEN=<redacted>", "rm", "x"]);
});

test("extractCommandTokens: unmatched-quote partial-leak matches spec", () => {
    // The bare branch of redact wipes through the first whitespace, so " def"
    // survives. Documented allowance for malformed input.
    assert.deepEqual(extractCommandTokens(`TOKEN="abc def`), ["TOKEN=<redacted>", "def"]);
});

test("extractCommandTokens: $VAR is not redaction-eligible", () => {
    assert.deepEqual(extractCommandTokens("echo $FOO_TOKEN"), ["echo", "$FOO_TOKEN"]);
});

test("extractCommandTokens: array elements preserve internal whitespace", () => {
    assert.deepEqual(extractCommandTokens(["sh", "-c", "rm x"]), ["sh", "-c", "rm x"]);
});

test("extractCommandTokens: empty / undefined / null inputs return []", () => {
    assert.deepEqual(extractCommandTokens(""), []);
    assert.deepEqual(extractCommandTokens(undefined), []);
    assert.deepEqual(extractCommandTokens(null), []);
});

test("analyzeCommand: detects structural signals without verb dictionary logic", () => {
    const cases: Array<{
        name: string;
        input: unknown;
        tokens?: string[];
        signals: string[];
        truncated?: boolean;
        overflowed?: boolean;
    }> = [
        {
            name: "shell wrapper bash -lc",
            input: ["bash", "-lc", "find . -exec rm {} ;"],
            tokens: ["bash", "-lc", "find . -exec rm {} ;"],
            signals: ["shell-wrapper", "find-exec"],
        },
        {
            name: "shell wrapper path basename",
            input: "/bin/sh -c echo ok",
            tokens: ["sh", "-c", "echo", "ok"],
            signals: ["shell-wrapper"],
        },
        {
            name: "shell wrapper xargs",
            input: "xargs sh -c 'rm -rf /'",
            tokens: ["xargs", "sh", "-c", "'rm", "…"],
            signals: ["shell-wrapper", "quoted-token", "overflowed"],
            overflowed: true,
        },
        {
            name: "shell wrapper env assignment",
            input: "env FOO=bar baz",
            signals: ["shell-wrapper"],
        },
        {
            name: "shell wrapper env short flag command",
            input: "env -i baz",
            signals: ["shell-wrapper"],
        },
        {
            name: "shell wrapper env long flag command",
            input: "env --unset=FOO baz",
            signals: ["shell-wrapper"],
        },
        {
            name: "env short flag without command is not shell wrapper",
            input: "env -i",
            signals: [],
        },
        {
            name: "env long flag without command is not shell wrapper",
            input: "env --null",
            signals: [],
        },
        {
            name: "env without assignment is not shell wrapper",
            input: "env baz",
            signals: [],
        },
        {
            name: "command substitution dollar parens",
            input: "echo $(pwd)",
            signals: ["command-substitution"],
        },
        {
            name: "command substitution backticks",
            input: "echo `pwd`",
            signals: ["command-substitution"],
        },
        {
            name: "variable expansion simple",
            input: "echo $HOME",
            signals: ["variable-expansion"],
        },
        {
            name: "variable expansion braces",
            input: "echo ${HOME}",
            signals: ["variable-expansion"],
        },
        {
            name: "wildcard star",
            input: "ls *.ts",
            signals: ["wildcard-expansion"],
        },
        {
            name: "wildcard single-quoted star is only quoted",
            input: "ls '*.ts'",
            signals: ["quoted-token"],
        },
        {
            name: "wildcard double-quoted star is only quoted",
            input: 'ls "*.ts"',
            signals: ["quoted-token"],
        },
        {
            name: "wildcard in unclosed single quote is detected",
            input: "ls 'unclosed *.ts",
            signals: ["wildcard-expansion", "quoted-token"],
        },
        {
            name: "wildcard question mark",
            input: "ls file?.ts",
            signals: ["wildcard-expansion"],
        },
        {
            name: "wildcard bracket",
            input: "ls file[0-9].ts",
            signals: ["wildcard-expansion"],
        },
        {
            name: "quoted double token",
            input: 'echo "hello world"',
            signals: ["quoted-token"],
        },
        {
            name: "quoted single token",
            input: "echo 'hello world'",
            signals: ["quoted-token"],
        },
        {
            name: "redirect stdout",
            input: "cat in > out",
            tokens: ["cat", "in"],
            signals: ["redirect", "truncated"],
            truncated: true,
        },
        {
            name: "redirect stderr",
            input: "cmd 2> err.log",
            tokens: ["cmd"],
            signals: ["redirect", "truncated"],
            truncated: true,
        },
        {
            name: "redirect heredoc string",
            input: "cmd <<< input",
            tokens: ["cmd"],
            signals: ["redirect", "truncated"],
            truncated: true,
        },
        {
            name: "pipeline is truncation but not redirect",
            input: "cmd1 | cmd2",
            tokens: ["cmd1"],
            signals: ["truncated"],
            truncated: true,
        },
        {
            name: "embedded stderr redirect",
            input: "cmd 2>/tmp/x",
            tokens: ["cmd", "x"],
            signals: ["redirect"],
        },
        {
            name: "embedded stdout redirect",
            input: "cmd >out",
            tokens: ["cmd", ">out"],
            signals: ["redirect"],
        },
        {
            name: "redacted placeholder is not a redirect",
            input: "TOKEN=<redacted> echo ok",
            tokens: ["TOKEN=<redacted>", "echo", "ok"],
            signals: [],
        },
        {
            name: "spaced stdout redirect",
            input: "cmd > out",
            tokens: ["cmd"],
            signals: ["redirect", "truncated"],
            truncated: true,
        },
        {
            name: "find exec",
            input: "find . -exec echo {} ;",
            tokens: ["find", ".", "-exec", "echo", "…"],
            signals: ["find-exec", "truncated", "overflowed"],
            truncated: true,
            overflowed: true,
        },
        {
            name: "find delete",
            input: "find . -delete",
            signals: ["find-exec"],
        },
        {
            name: "find without exec or delete",
            input: "find . -type f",
            signals: [],
        },
        {
            name: "overflowed token list",
            input: "a b c d e",
            tokens: ["a", "b", "c", "d", "…"],
            signals: ["overflowed"],
            overflowed: true,
        },
        {
            name: "long token capped",
            input: `echo ${"x".repeat(80)}`,
            signals: ["truncated"],
            truncated: true,
        },
        {
            name: "redact happens after signal detection",
            input: 'SECRET="$(pwd)" echo ok',
            tokens: ["SECRET=<redacted>", "echo", "ok"],
            signals: ["command-substitution", "quoted-token"],
        },
        {
            name: "array command joins for structural detection",
            input: ["bash", "-lc", "echo $HOME"],
            signals: ["shell-wrapper", "variable-expansion"],
        },
        {
            name: "plain command has no structural signal",
            input: "git status -s",
            signals: [],
        },
        {
            name: "rm-staging script is not shell wrapper or substitution",
            input: "./rm-staging.sh",
            tokens: ["rm-staging.sh"],
            signals: [],
        },
        {
            name: "escaped dollar is not variable expansion",
            input: String.raw`echo \$HOME`,
            signals: [],
        },
        {
            name: "control command separator truncates but is not redirect",
            input: "cmd && other",
            tokens: ["cmd"],
            signals: ["truncated"],
            truncated: true,
        },
    ];

    for (const c of cases) {
        const actual = analyzeCommand(c.input);
        assert.deepEqual(actual.structuralSignals, c.signals, c.name);
        assert.equal(actual.truncated, c.truncated ?? false, c.name);
        assert.equal(actual.overflowed, c.overflowed ?? false, c.name);
        if (c.tokens) assert.deepEqual(actual.tokens, c.tokens, c.name);
    }
});

test("analyzeCommand: invalid or tokenless input falls back to truncated analysis", () => {
    const expected = {
        tokens: [],
        structuralSignals: ["truncated"],
        truncated: true,
        overflowed: false,
    };

    assert.deepEqual(analyzeCommand(undefined), expected);
    assert.deepEqual(analyzeCommand(null), expected);
    assert.deepEqual(analyzeCommand(""), expected);
    assert.deepEqual(analyzeCommand("   "), expected);
    assert.deepEqual(analyzeCommand(123), expected);
    assert.deepEqual(analyzeCommand({ command: "ls" }), expected);
    assert.deepEqual(analyzeCommand([]), expected);
    assert.deepEqual(analyzeCommand(["echo", 123]), expected);
    assert.deepEqual(analyzeCommand(["bash", null]), expected);
});

test("analyzeCommand: token output remains compatible with extractCommandTokens", () => {
    const cases: Array<string | string[] | undefined | null> = [
        "rm README.md",
        ["rm", "README.md"],
        "git push origin main",
        "rm -rf /path/to/dir",
        "./script.sh a b c d",
        "cat in > out.txt",
        'TOKEN="abc def" rm x',
        undefined,
        null,
        "",
    ];

    for (const input of cases) {
        assert.deepEqual(analyzeCommand(input).tokens, extractCommandTokens(input));
    }
});
