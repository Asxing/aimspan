import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  MARKDOWN_ALLOWLIST,
  ROOT_README_OWNERSHIP,
  checkRepository,
  extractMarkdownLinks,
  findFormerNameOccurrences,
  findMachineUserDirectoryOccurrences,
  findUncataloguedCjk,
  isProcessOrBackupPath,
  sortDiagnostics,
} from "./check-repo-hygiene.mjs";

const execFileAsync = promisify(execFile);

test("CJK display copy is confined to the Chinese catalog and test files", () => {
  for (const path of ["apps/desktop/src/renderer/App.tsx", "packages/core/src/adapter.ts", "packages/protocol/src/index.ts"]) {
    assert.deepEqual(findUncataloguedCjk(path, 'const x = "保存";\n// 中文'), [{ line: 1, column: 12 }, { line: 2, column: 4 }]);
    assert.equal(findUncataloguedCjk(path, 'const x = "保存"; // i18n-allow').length, 1);
    assert.deepEqual(findUncataloguedCjk(path, 'const x = "用户消息"; // i18n-allow: parse native source labels'), []);
    for (const text of ["日本語", "かな", "カナ", "한국어"]) assert.equal(findUncataloguedCjk(path, text).length, 1);
  }
  for (const path of ["apps/desktop/src/shared/i18n/zh-CN.ts", "apps/desktop/src/renderer/App.test.tsx", "packages/core/src/core.test.ts", "docs/PRODUCT.md"]) {
    assert.deepEqual(findUncataloguedCjk(path, "中文"), []);
  }
  assert.equal(findUncataloguedCjk("apps/desktop/src/shared/i18n/en.ts", "中文").length, 1);
});

test("uses the explicit twelve-file Markdown allowlist", () => {
  assert.deepEqual(MARKDOWN_ALLOWLIST, [
    ".github/PULL_REQUEST_TEMPLATE.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "README.md",
    "README.zh-CN.md",
    "SECURITY.md",
    "docs/ARCHITECTURE.md",
    "docs/CORE-PROTOCOL.md",
    "docs/PRODUCT.md",
    "docs/ROADMAP.md",
    "docs/SECURITY.md",
    "docs/STATUS.md",
  ]);
  assert.deepEqual(ROOT_README_OWNERSHIP, [
    "CONTRIBUTING.md",
    "README.zh-CN.md",
    "SECURITY.md",
    "docs/ARCHITECTURE.md",
    "docs/CORE-PROTOCOL.md",
    "docs/PRODUCT.md",
    "docs/ROADMAP.md",
    "docs/SECURITY.md",
    "docs/STATUS.md",
  ]);
});

test("finds all former-name spellings without flagging the current name", () => {
  const joined = ["Agents", "TODO"].join("");
  const hyphenated = ["agents", "todo"].join("-");
  const underscored = ["AGENTS", "TODO"].join("_");
  const spaced = ["Agents", "Todo"].join(" ");
  const occurrences = findFormerNameOccurrences(`${joined} ${hyphenated} ${underscored} ${spaced} aimspan agent todo`);
  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.value),
    [joined, hyphenated, underscored, spaced],
  );
});

test("allows the sentinel and finds macOS, Linux, root, and Windows user directories", () => {
  const slash = "/";
  const backslash = "\\";
  const valid = [
    ["", "Users", "__aimspan_fixture__", "project"].join(slash),
    ["", "home", "__aimspan_fixture__", "project"].join(slash),
    ["C:", "Users", "__aimspan_fixture__", "project"].join(backslash),
    "https://example.invalid/root/api",
    "https://example.invalid/home/user",
    "https://example.invalid/Users/user",
  ];
  const invalid = [
    ["", "Users", "local-developer", "project"].join(slash),
    ["", "home", "local-developer", "project"].join(slash),
    ["", "root", "project"].join(slash),
    ["D:", "Users", "local-developer", "project"].join(backslash),
    ["F:", "Users", "forward-developer", "project"].join(slash),
    ["E:", "Users", "escaped-developer", "project"].join(backslash.repeat(2)),
  ];
  const occurrences = findMachineUserDirectoryOccurrences([...valid, ...invalid].join("\n"));
  assert.deepEqual(occurrences.map((occurrence) => occurrence.value), [
    ["", "Users", "local-developer"].join(slash),
    ["", "home", "local-developer"].join(slash),
    ["", "root"].join(slash),
    ["D:", "Users", "local-developer"].join(backslash),
    ["F:", "Users", "forward-developer"].join(slash),
    ["E:", "Users", "escaped-developer"].join(backslash.repeat(2)),
  ]);
});

test("recognizes process-history and backup paths by path, not prose", () => {
  assert.equal(isProcessOrBackupPath("docs/ADR-0001-old-choice.md"), true);
  assert.equal(isProcessOrBackupPath("docs/history/decision.md"), true);
  assert.equal(isProcessOrBackupPath("src/module.ts.bak"), true);
  assert.equal(isProcessOrBackupPath("src/module-old.ts"), true);
  assert.equal(isProcessOrBackupPath("src/module-final.ts"), true);
  assert.equal(isProcessOrBackupPath("docs/plan-v2.md"), true);
  assert.equal(isProcessOrBackupPath("crates/core/src/schema_v2.rs"), false);
  assert.equal(isProcessOrBackupPath("docs/STATUS.md"), false);
  assert.equal(isProcessOrBackupPath("src/process-manager.ts"), false);
});

test("extracts local Markdown links but ignores code examples", () => {
  const source = [
    "[inline](docs/PRODUCT.md)",
    "`[inline code](missing.md)`",
    "```md",
    "[fenced](also-missing.md)",
    "```",
    "<!-- [hidden](hidden.md) -->",
    "[reference]: <docs/ARCHITECTURE.md>",
  ].join("\n");
  assert.deepEqual(
    extractMarkdownLinks(source).map((link) => link.target),
    ["docs/PRODUCT.md", "docs/ARCHITECTURE.md"],
  );
  assert.deepEqual(extractMarkdownLinks("<!-- [hidden](docs/PRODUCT.md)\n[still hidden](docs/STATUS.md)"), []);
});

test("sorts diagnostics deterministically by location and code", () => {
  const diagnostics = [
    { path: "z", line: 1, code: "b", message: "last" },
    { path: "a", line: 2, code: "b", message: "second" },
    { path: "a", line: 1, code: "z", message: "first" },
  ];
  assert.deepEqual(
    sortDiagnostics(diagnostics).map((item) => item.message),
    ["first", "second", "last"],
  );
});

test("checks a temporary Git repository end to end", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "aimspan-hygiene-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q"], { cwd: root });

  const rootReadmeLinks = ROOT_README_OWNERSHIP.map((path) => `[${path}](${path})`);
  const contents = new Map([
    ["AGENTS.md", "# Repository guidance\n"],
    ["README.md", `# aimspan\n\n${rootReadmeLinks.join("\n")}\n`],
  ]);
  for (const path of MARKDOWN_ALLOWLIST) {
    if (!contents.has(path)) contents.set(path, `# ${path}\n`);
  }
  contents.set(".gitignore", "ignored.txt\n");
  contents.set("tracked.txt", "tracked\n");
  for (const [path, content] of contents) await writeFixture(root, path, content);
  await execFileAsync("git", ["add", "."], { cwd: root });

  const clean = await checkRepository(root);
  assert.equal(clean.ok, true, clean.diagnostics.map((item) => `${item.code}: ${item.path}`).join("\n"));

  await writeFixture(
    root,
    "README.md",
    contents.get("README.md").replace(
      "[docs/PRODUCT.md](docs/PRODUCT.md)",
      "<!-- [docs/PRODUCT.md](docs/PRODUCT.md) -->",
    ),
  );
  const hiddenOwnership = await checkRepository(root);
  assert.equal(hiddenOwnership.diagnostics.some((item) => item.code === "readme-ownership-missing"), true);
  await writeFixture(root, "README.md", contents.get("README.md"));

  const formerName = ["Agents", "TODO"].join("");
  const machinePath = ["", "Users", "local-developer", "private"].join("/");
  await writeFixture(root, "docs/EXTRA.md", "# Duplicate documentation\n");
  await writeFixture(root, "backups/snapshot.txt", "old\n");
  await writeFixture(root, "src/example.ts", `${formerName} ${machinePath}\n`);
  await writeFixture(root, "docs/untracked.txt", "untracked\n");
  await writeFixture(root, "ignored.txt", "tracked but ignored\n");
  await execFileAsync("git", ["add", "-f", "ignored.txt"], { cwd: root });
  await unlink(join(root, "tracked.txt"));
  const outside = await mkdtemp(join(tmpdir(), "aimspan-hygiene-outside-"));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await writeFixture(outside, "secret.txt", `${formerName}\n`);
  await symlink(join(outside, "secret.txt"), join(root, "external-link.txt"));
  await writeFixture(
    root,
    "README.md",
    `${contents.get("README.md")}\n[case](docs/product.md)\n[untracked](docs/untracked.txt)\n[outside](../outside.md)\n`,
  );
  await writeFixture(root, "apps/desktop/src/renderer/inline.tsx", 'const text = "未翻译";\n');
  const dirty = await checkRepository(root);
  assert.equal(dirty.ok, false);
  const codes = new Set(dirty.diagnostics.map((item) => item.code));
  for (const code of [
    "candidate-symlink-boundary",
    "former-product-name",
    "machine-user-directory",
    "markdown-link-boundary",
    "markdown-link-case",
    "markdown-link-untracked",
    "markdown-not-allowlisted",
    "process-or-backup-path",
    "tracked-ignored",
    "tracked-file-missing",
    "uncatalogued-cjk",
  ]) {
    assert.equal(codes.has(code), true, `missing diagnostic ${code}`);
  }
  assert.equal(
    dirty.diagnostics.some((item) => item.path === "external-link.txt" && item.code === "former-product-name"),
    false,
    "external symlink contents must never be read",
  );
  assert.deepEqual(dirty.diagnostics, sortDiagnostics(dirty.diagnostics));
});

async function writeFixture(root, path, content) {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}
