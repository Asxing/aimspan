import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

/** The repository's complete, intentionally small Markdown surface. */
export const MARKDOWN_ALLOWLIST = Object.freeze([
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

export const ROOT_README_OWNERSHIP = Object.freeze(
  MARKDOWN_ALLOWLIST.filter((path) => !new Set([".github/PULL_REQUEST_TEMPLATE.md", "AGENTS.md", "README.md"]).has(path)),
);

const FORBIDDEN_PROCESS_FILENAMES = [
  /^ADR(?:-|_|\.)/i,
  /^MILESTONE(?:-|_|\.)/i,
  /^IMPLEMENTATION(?:-|_)PLAN(?:\.|-|_)/i,
  /^REVIEW(?:-|_)DECISIONS?(?:\.|-|_)/i,
  /(?:^|[-_.])(?:old|new|final|backup|copy)(?=[-_.]|$)/i,
  /\.(?:bak|backup|old|orig|rej|tmp)$/i,
  /~$/,
];

const FORBIDDEN_PROCESS_SEGMENTS = new Set([
  "archive",
  "archives",
  "backup",
  "backups",
  "historical",
  "history",
  "milestones",
  "progress-logs",
  "superseded",
]);

const FORMER_NAME = /agents(?:\s+|[-_]?)(?:todo)s?/giu;
const ALLOWED_FIXTURE_USER = "__aimspan_fixture__";
const UNIX_ROOT_HOME = ["", "root"].join("/");

const MACHINE_USER_DIRECTORY_PATTERNS = [
  { pattern: /(?<![A-Za-z]:)(?<![A-Za-z\d])\/Users\/([^/\s'"`<>()\[\]{}\\:;,]+)/gu, userGroup: 1 },
  { pattern: /(?<![A-Za-z]:)(?<![A-Za-z\d])\/home\/([^/\s'"`<>()\[\]{}\\:;,]+)/gu, userGroup: 1 },
  {
    pattern: new RegExp(`(?<![A-Za-z\\d])${UNIX_ROOT_HOME}(?=/|[\\s'"\`<>()\\[\\]{}\\\\:;,]|$)`, "gu"),
    userGroup: null,
  },
  {
    pattern: /[A-Za-z]:[\\/]+Users[\\/]+([^/\\\s'"`<>()\[\]{}:;,]+)/giu,
    userGroup: 1,
  },
];

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortDiagnostics(diagnostics) {
  return [...diagnostics].sort(
    (left, right) =>
      compareText(left.path ?? "", right.path ?? "") ||
      (left.line ?? 0) - (right.line ?? 0) ||
      (left.column ?? 0) - (right.column ?? 0) ||
      compareText(left.code, right.code) ||
      compareText(left.message, right.message),
  );
}

export function isProcessOrBackupPath(path) {
  const normalized = normalizeGitPath(path);
  const parts = normalized.split("/");
  if (parts.some((part) => FORBIDDEN_PROCESS_SEGMENTS.has(part.toLowerCase()))) return true;
  const filename = parts.at(-1) ?? "";
  if (FORBIDDEN_PROCESS_FILENAMES.some((pattern) => pattern.test(filename))) return true;
  return /^(?:docs|research)\//u.test(normalized) && /(?:^|[-_.])v\d+(?=[-_.]|$)/iu.test(filename);
}

export function findFormerNameOccurrences(source) {
  return findOccurrences(source, FORMER_NAME);
}

/** Display copy belongs in the catalogs; native parsing exceptions need a reason. */
export function findUncataloguedCjk(path, source) {
  if (!/^(?:apps\/desktop\/src\/|packages\/[^/]+\/src\/)/u.test(path) ||
      path === "apps/desktop/src/shared/i18n/zh-CN.ts" || /\.test\.[^/]+$/u.test(path)) return [];
  return source.split("\n").flatMap((line, index) => {
    if (/\/\/ i18n-allow(?:\s*:\s*|\s+-\s+|\s+)\S/u.test(line)) return [];
    const column = line.search(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u);
    return column < 0 ? [] : [{ line: index + 1, column: column + 1 }];
  });
}

export function findMachineUserDirectoryOccurrences(source) {
  const occurrences = [];
  for (const { pattern, userGroup } of MACHINE_USER_DIRECTORY_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (userGroup !== null && match[userGroup] === ALLOWED_FIXTURE_USER) continue;
      occurrences.push({ ...positionAt(source, match.index), offset: match.index, value: match[0] });
    }
  }
  return occurrences.sort((left, right) => left.offset - right.offset);
}

/**
 * Extract inline and reference-definition Markdown destinations while ignoring
 * fenced and inline code. This intentionally does not interpret HTML.
 */
export function extractMarkdownLinks(source) {
  const links = [];
  const lines = maskHtmlComments(source).split("\n");
  let offset = 0;
  let fence = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const length = fenceMatch[1].length;
      if (fence === null) fence = { marker, length };
      else if (fence.marker === marker && length >= fence.length) fence = null;
      offset += line.length + 1;
      continue;
    }
    if (fence !== null) {
      offset += line.length + 1;
      continue;
    }

    const visible = maskInlineCode(line);
    const inline = /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/gu;
    for (const match of visible.matchAll(inline)) {
      const rawTarget = match[1];
      const targetOffset = match.index + match[0].indexOf(rawTarget);
      links.push({
        target: unwrapAngleTarget(rawTarget),
        line: lineIndex + 1,
        column: targetOffset + 1,
        offset: offset + targetOffset,
      });
    }

    const definition = visible.match(/^\s{0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/u);
    if (definition) {
      const rawTarget = definition[1];
      const targetOffset = visible.indexOf(rawTarget);
      links.push({
        target: unwrapAngleTarget(rawTarget),
        line: lineIndex + 1,
        column: targetOffset + 1,
        offset: offset + targetOffset,
      });
    }

    offset += line.length + 1;
  }

  return links;
}

export async function checkRepository(repositoryRoot) {
  const root = await realpath(resolve(repositoryRoot));
  const diagnostics = [];
  const [candidateFiles, trackedFiles, trackedIgnoredFiles] = await Promise.all([
    listGitFiles(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
    listGitFiles(root, ["ls-files", "--cached", "-z"]),
    listGitFiles(root, ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"]),
  ]);
  const candidates = uniqueSorted(candidateFiles.map(normalizeGitPath));
  const tracked = new Set(trackedFiles.map(normalizeGitPath));
  const readableCandidates = [];

  for (const path of uniqueSorted(trackedIgnoredFiles.map(normalizeGitPath))) {
    diagnostics.push(diagnostic("tracked-ignored", path, "Tracked file also matches .gitignore."));
  }

  for (const path of candidates) {
    const absolute = resolve(root, ...path.split("/"));
    try {
      const metadata = await lstat(absolute);
      if (metadata.isDirectory()) continue;
      const resolvedTarget = await realpath(absolute);
      if (!isWithin(root, resolvedTarget) && resolvedTarget !== root) {
        diagnostics.push(
          diagnostic("candidate-symlink-boundary", path, "Git-listed path resolves outside the repository and was not read."),
        );
        continue;
      }
      readableCandidates.push({ path, absolute: resolvedTarget });
    } catch (error) {
      diagnostics.push(
        diagnostic(
          tracked.has(path) ? "tracked-file-missing" : "candidate-unreadable",
          path,
          tracked.has(path)
            ? "Tracked file is missing from the working tree."
            : `Git-listed file cannot be inspected: ${errorCode(error)}.`,
        ),
      );
    }
  }
  const readableSet = new Set(readableCandidates.map(({ path }) => path));
  const markdown = candidates.filter((path) => path.toLowerCase().endsWith(".md"));
  const markdownAllowed = new Set(MARKDOWN_ALLOWLIST);
  for (const path of markdown) {
    if (!markdownAllowed.has(path)) {
      diagnostics.push(diagnostic("markdown-not-allowlisted", path, "Markdown file is outside the explicit canonical allowlist."));
    }
  }
  const candidateSet = new Set(candidates);
  for (const path of MARKDOWN_ALLOWLIST) {
    if (!candidateSet.has(path) || !readableSet.has(path)) {
      diagnostics.push(diagnostic("canonical-markdown-missing", path, "Canonical Markdown file is missing."));
    }
  }

  for (const path of candidates) {
    if (isProcessOrBackupPath(path)) {
      diagnostics.push(diagnostic("process-or-backup-path", path, "Process-history or backup paths are not repository source."));
    }
  }

  const textByPath = new Map();
  for (const { path, absolute } of readableCandidates) {
    let bytes;
    try {
      bytes = await readFileNoFollow(absolute);
    } catch (error) {
      diagnostics.push(
        diagnostic("candidate-unreadable", path, `Git-listed file cannot be read without following a symlink: ${errorCode(error)}.`),
      );
      continue;
    }
    const source = decodeText(bytes);
    if (source === null) continue;
    textByPath.set(path, source);

    for (const occurrence of findUncataloguedCjk(path, source)) {
      diagnostics.push(diagnostic("uncatalogued-cjk", path,
        "CJK copy must be in zh-CN.ts; native parsing exceptions require // i18n-allow with a reason.", occurrence));
    }

    for (const occurrence of findFormerNameOccurrences(source)) {
      diagnostics.push(
        diagnostic("former-product-name", path, "Former product name remains in repository text.", occurrence),
      );
    }
    for (const occurrence of findMachineUserDirectoryOccurrences(source)) {
      diagnostics.push(
        diagnostic(
          "machine-user-directory",
          path,
          `Machine-specific user directory remains; use the ${ALLOWED_FIXTURE_USER} sentinel for synthetic fixtures.`,
          occurrence,
        ),
      );
    }
  }

  for (const path of markdown.filter((candidate) => markdownAllowed.has(candidate))) {
    const source = textByPath.get(path);
    if (source === undefined) continue;
    for (const link of extractMarkdownLinks(source)) {
      await checkMarkdownLink({ root, sourcePath: path, link, tracked, diagnostics });
    }
  }

  checkReadmeOwnership({
    path: "README.md",
    source: textByPath.get("README.md"),
    requiredTargets: ROOT_README_OWNERSHIP,
    diagnostics,
  });

  const sortedDiagnostics = sortDiagnostics(diagnostics);
  return {
    ok: sortedDiagnostics.length === 0,
    diagnostics: sortedDiagnostics,
    checkedFiles: candidates.length,
    trackedFiles: tracked.size,
  };
}

export function formatDiagnostic(item) {
  const location = [item.path, item.line, item.column].filter((value) => value !== undefined).join(":");
  return `${location} [${item.code}] ${item.message}`;
}

function diagnostic(code, path, message, position = {}) {
  return {
    code,
    path,
    ...(position.line === undefined ? {} : { line: position.line }),
    ...(position.column === undefined ? {} : { column: position.column }),
    message,
  };
}

function findOccurrences(source, pattern) {
  const occurrences = [];
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    occurrences.push({ ...positionAt(source, match.index), value: match[0] });
  }
  return occurrences;
}

function positionAt(source, offset) {
  const before = source.slice(0, offset);
  const lastNewline = before.lastIndexOf("\n");
  return {
    line: countNewlines(before) + 1,
    column: offset - lastNewline,
  };
}

function countNewlines(value) {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) === 10) count += 1;
  return count;
}

function maskInlineCode(line) {
  const characters = line.split("");
  let index = 0;
  while (index < characters.length) {
    if (characters[index] !== "`") {
      index += 1;
      continue;
    }
    let ticks = 1;
    while (characters[index + ticks] === "`") ticks += 1;
    const marker = "`".repeat(ticks);
    const remainder = characters.slice(index + ticks).join("");
    const closing = remainder.indexOf(marker);
    if (closing < 0) break;
    const end = index + ticks + closing + ticks;
    for (let masked = index; masked < end; masked += 1) characters[masked] = " ";
    index = end;
  }
  return characters.join("");
}

function maskHtmlComments(source) {
  return source.replace(/<!--[\s\S]*?(?:-->|$)/gu, (comment) => comment.replace(/[^\r\n]/g, " "));
}

function unwrapAngleTarget(target) {
  return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
}

async function checkMarkdownLink({ root, sourcePath, link, tracked, diagnostics }) {
  const decoded = decodeMarkdownTarget(link.target);
  if (decoded === null) {
    diagnostics.push(diagnostic("markdown-link-invalid", sourcePath, "Local Markdown link is not valid percent-encoding.", link));
    return;
  }
  if (isExternalOrAnchor(decoded)) return;

  const withoutSuffix = decoded.split(/[?#]/u, 1)[0];
  if (withoutSuffix.length === 0) return;
  if (withoutSuffix.includes("\\") || isAbsolute(withoutSuffix)) {
    diagnostics.push(diagnostic("markdown-link-boundary", sourcePath, "Local Markdown link must be repository-relative.", link));
    return;
  }

  const sourceDirectory = resolve(root, ...sourcePath.split("/").slice(0, -1));
  const absolute = resolve(sourceDirectory, withoutSuffix);
  if (!isWithin(root, absolute) || absolute === root) {
    diagnostics.push(diagnostic("markdown-link-boundary", sourcePath, "Local Markdown link escapes the repository.", link));
    return;
  }
  const relativeTarget = normalizeGitPath(relative(root, absolute));
  const caseResult = await inspectPathCase(root, relativeTarget);
  if (caseResult.kind === "missing") {
    diagnostics.push(diagnostic("markdown-link-missing", sourcePath, `Local target does not exist: ${relativeTarget}.`, link));
    return;
  }
  if (caseResult.kind === "case-mismatch") {
    diagnostics.push(
      diagnostic("markdown-link-case", sourcePath, `Local target case differs from tracked path: ${caseResult.actual}.`, link),
    );
    return;
  }

  let targetMetadata;
  try {
    targetMetadata = await lstat(absolute);
    const realTarget = await realpath(absolute);
    if (!isWithin(root, realTarget) && realTarget !== root) {
      diagnostics.push(diagnostic("markdown-link-boundary", sourcePath, "Local Markdown link resolves outside the repository.", link));
      return;
    }
  } catch {
    diagnostics.push(diagnostic("markdown-link-missing", sourcePath, `Local target does not exist: ${relativeTarget}.`, link));
    return;
  }

  const isTracked = targetMetadata.isDirectory()
    ? [...tracked].some((path) => path.startsWith(`${relativeTarget}/`))
    : tracked.has(relativeTarget);
  if (!isTracked) {
    diagnostics.push(diagnostic("markdown-link-untracked", sourcePath, `Local target is not tracked: ${relativeTarget}.`, link));
  }
}

async function inspectPathCase(root, relativeTarget) {
  const parts = relativeTarget.split("/").filter(Boolean);
  let directory = root;
  const actualParts = [];
  for (let index = 0; index < parts.length; index += 1) {
    let entries;
    try {
      entries = await readdir(directory);
    } catch {
      return { kind: "missing" };
    }
    const expected = parts[index];
    if (entries.includes(expected)) {
      actualParts.push(expected);
      directory = resolve(directory, expected);
      continue;
    }
    const folded = entries.find((entry) => entry.toLocaleLowerCase("en-US") === expected.toLocaleLowerCase("en-US"));
    if (folded !== undefined) {
      actualParts.push(folded, ...parts.slice(index + 1));
      return { kind: "case-mismatch", actual: actualParts.join("/") };
    }
    return { kind: "missing" };
  }
  return { kind: "exact" };
}

function checkReadmeOwnership({ path, source, requiredTargets, diagnostics }) {
  if (source === undefined) return;
  const links = extractMarkdownLinks(source);
  const directoryParts = path.split("/").slice(0, -1);
  const normalizedTargets = new Set();
  for (const link of links) {
    const decoded = decodeMarkdownTarget(link.target);
    if (decoded === null || isExternalOrAnchor(decoded)) continue;
    const local = decoded.split(/[?#]/u, 1)[0];
    if (!local || isAbsolute(local) || local.includes("\\")) continue;
    normalizedTargets.add(normalizeGitPath(resolve("/", ...directoryParts, local).slice(1)));
  }
  for (const target of requiredTargets) {
    if (!normalizedTargets.has(target)) {
      diagnostics.push(diagnostic("readme-ownership-missing", path, `Ownership index must link to ${target}.`));
    }
  }
}

function decodeMarkdownTarget(target) {
  try {
    return decodeURIComponent(target.replaceAll("\\ ", " "));
  } catch {
    return null;
  }
}

function isExternalOrAnchor(target) {
  return target.startsWith("#") || target.startsWith("//") || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(target);
}

function decodeText(bytes) {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function readFileNoFollow(path) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      const error = new Error("Path is not a regular file.");
      error.code = "NOT_REGULAR_FILE";
      throw error;
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function listGitFiles(root, args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function normalizeGitPath(path) {
  return path.split(sep).join("/").replace(/^\.\//u, "");
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareText);
}

function isWithin(root, target) {
  const relation = relative(root, target);
  return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

function errorCode(error) {
  return error?.code ?? error?.name ?? "unknown error";
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repositoryRoot = process.argv[2] ?? resolve(import.meta.dirname, "..");
  try {
    const result = await checkRepository(repositoryRoot);
    if (result.ok) {
      process.stdout.write(`Repository hygiene OK (${result.checkedFiles} checked files, ${result.trackedFiles} tracked).\n`);
    } else {
      process.stderr.write(`Repository hygiene failed with ${result.diagnostics.length} issue(s):\n`);
      for (const item of result.diagnostics) process.stderr.write(`- ${formatDiagnostic(item)}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`Repository hygiene check could not run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
