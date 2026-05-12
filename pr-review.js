#!/usr/bin/env node
/**
 * pr-review.js — Rule-based local PR reviewer (ESM, no AI, no API key)
 * Runs automatically via .git/hooks/post-commit
 *
 * Manual usage:
 *   node pr-review.js                   # review last commit  (default)
 *   node pr-review.js --commits 3       # review last 3 commits
 *   node pr-review.js --base main       # review diff against a base branch
 *   node pr-review.js --staged          # review only staged changes
 *   node pr-review.js --output out.md   # save report to a specific file
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { commits: 1, base: null, staged: false, output: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--commits" && args[i + 1])
      opts.commits = parseInt(args[++i]);
    if (args[i] === "--base" && args[i + 1]) opts.base = args[++i];
    if (args[i] === "--staged") opts.staged = true;
    if (args[i] === "--output" && args[i + 1]) opts.output = args[++i];
    if (args[i] === "--help") {
      console.log(`
Usage: node pr-review.js [options]

  --commits <n>     Review last n commits (default: 1)
  --base <branch>   Review diff against a base branch (e.g. main)
  --staged          Review only staged (git add) changes
  --output <file>   Save report to a markdown file
  --help            Show this help
      `);
      process.exit(0);
    }
  }
  return opts;
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function getDiff(opts) {
  if (opts.staged) return run("git diff --cached");
  if (opts.base) return run(`git diff ${opts.base}...HEAD`);
  return run(`git diff HEAD~${opts.commits} HEAD`);
}

function getChangedFiles(opts) {
  if (opts.staged)
    return run("git diff --cached --name-only").split("\n").filter(Boolean);
  if (opts.base)
    return run(`git diff ${opts.base}...HEAD --name-only`)
      .split("\n")
      .filter(Boolean);
  return run(`git diff HEAD~${opts.commits} HEAD --name-only`)
    .split("\n")
    .filter(Boolean);
}

function getCommits(opts) {
  if (opts.staged) return ["(staged changes — not yet committed)"];
  if (opts.base)
    return run(`git log ${opts.base}...HEAD --oneline`)
      .split("\n")
      .filter(Boolean);
  return run(`git log -${opts.commits} --oneline`).split("\n").filter(Boolean);
}

// ─── Rules loader ─────────────────────────────────────────────────────────────

const RULES_FILE = "pr-review-rules.md";

function loadRules() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, RULES_FILE);
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf8");
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const local = path.join(__dirname, RULES_FILE);
  if (fs.existsSync(local)) return fs.readFileSync(local, "utf8");
  return null;
}

function parseRules(md) {
  const rules = [];
  let category = "General";
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      category = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("# ")) {
      category = line.slice(2).trim();
      continue;
    }
    if (!line.startsWith("- ") && !line.startsWith("* ")) continue;
    const text = line.slice(2).trim();
    rules.push({ category, text, checks: buildChecks(category, text) });
  }
  return rules;
}

// ─── Rule → checker mapping ───────────────────────────────────────────────────

function buildChecks(category, text) {
  const t = text.toLowerCase();
  const checks = [];

  // ── Code Quality ─────────────────────────────────────────────────────────────

  if (t.includes("magic number") || t.includes("magic string")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const hits = lines.filter((l) => {
        if (/^\s*(\/\/|#|\*)/.test(l.code)) return false;
        // Strip JSX className strings and SVG/HTML attribute values to avoid Tailwind class numbers
        const stripped = l.code
          .replace(/className\s*=\s*{[^}]*}/g, "")
          .replace(/className\s*=\s*["'`][^"'`]*["'`]/g, "")
          .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "")
          .replace(
            /\b(strokeWidth|fillRule|clipRule|viewBox|xmlns|animationDelay|tabIndex)\b[^,;\n]*/g,
            "",
          );
        // Only flag bare numbers in JS logic — not inside strings or SVG/HTML attrs
        return /(?<![a-zA-Z0-9_%'"`.\-])\d{2,}(?![a-zA-Z0-9_%'"`])/.test(
          stripped,
        );
      });
      return hits.length
        ? `Magic numbers on line(s) ${hits.map((l) => l.no).join(", ")} — use named constants`
        : null;
    });
  }

  if (
    t.includes("dead code") ||
    t.includes("commented-out") ||
    t.includes("unused import")
  ) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const hits = lines.filter((l) =>
        /^\s*(\/\/|#)\s*(import |require\(|def |function |const |let |var )/.test(
          l.code,
        ),
      );
      return hits.length
        ? `Commented-out code on line(s) ${hits.map((l) => l.no).join(", ")} — remove before merging`
        : null;
    });
  }

  if (t.includes("40 lines") || t.includes("longer than")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      // Find consecutive added-line blocks that look like a single function body
      let funcStart = null;
      let funcLen = 0;
      let depth = 0;
      let violations = [];
      for (const l of lines) {
        const stripped = l.code
          .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "")
          .replace(/\/\/.*$/, "");
        const isFuncStart =
          /\b(function\s+\w+|const\s+\w+\s*=\s*(async\s*)?\(|=>\s*\{)/.test(
            stripped,
          );
        if (isFuncStart && depth === 0) {
          funcStart = l.no;
          funcLen = 0;
        }
        depth +=
          (stripped.match(/\{/g) || []).length -
          (stripped.match(/\}/g) || []).length;
        if (funcStart !== null) funcLen++;
        if (depth <= 0 && funcStart !== null) {
          if (funcLen > 40)
            violations.push(
              `function starting at line ${funcStart} (~${funcLen} lines)`,
            );
          funcStart = null;
          funcLen = 0;
          depth = 0;
        }
      }
      return violations.length
        ? `Long function(s) detected: ${violations.join("; ")}`
        : null;
    });
  }

  if (t.includes("deeply nested") || t.includes("3 levels")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      // Track actual brace/paren depth instead of indentation (JSX indents deeply but isn't logic nesting)
      let depth = 0;
      const deep = [];
      for (const l of lines) {
        const stripped = l.code
          .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "")
          .replace(/\/\/.*$/g, "");
        const opens = (stripped.match(/[{(]/g) || []).length;
        const closes = (stripped.match(/[})]/g) || []).length;
        depth += opens - closes;
        // Only flag JS logic nesting (if/for/while/function) not JSX return blocks
        if (
          depth > 4 &&
          /\b(if|for|while|switch|function|=>)\b/.test(stripped)
        ) {
          deep.push(l);
        }
      }
      return deep.length
        ? `Deeply nested logic (4+ levels) on line(s) ${deep.map((l) => l.no).join(", ")}`
        : null;
    });
  }

  // ── Security ──────────────────────────────────────────────────────────────────

  if (
    t.includes("hardcoded secret") ||
    t.includes("api key") ||
    t.includes("password") ||
    t.includes("token")
  ) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const patterns = [
        /(?:api[_-]?key|apikey|secret|password|passwd|token|auth)\s*[:=]\s*['"`][^'"`]{6,}/i,
        /sk-[a-zA-Z0-9]{20,}/,
        /ghp_[a-zA-Z0-9]{30,}/,
        /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
      ];
      const hits = lines.filter((l) => patterns.some((p) => p.test(l.code)));
      return hits.length
        ? `⚠️  Possible hardcoded secret on line(s) ${hits.map((l) => l.no).join(", ")}`
        : null;
    });
  }

  if (t.includes("eval") || t.includes("exec")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const hits = lines.filter(
        (l) =>
          /\beval\s*\(|\bexec\s*\(/.test(l.code) &&
          !/^\s*(\/\/|#)/.test(l.code),
      );
      return hits.length
        ? `Dangerous eval/exec on line(s) ${hits.map((l) => l.no).join(", ")}`
        : null;
    });
  }

  if (t.includes("dangerouslysetinnerhtml")) {
    checks.push((lines, file) => {
      // Only relevant in JSX/TSX — skip .md, .js rule files, etc.
      if (!/\.[jt]sx$/.test(file)) return null;
      const hits = lines.filter((l) =>
        /dangerouslySetInnerHTML\s*=\s*\{/.test(l.code),
      );
      return hits.length
        ? `dangerouslySetInnerHTML on line(s) ${hits.map((l) => l.no).join(", ")} — ensure justified`
        : null;
    });
  }

  if (
    t.includes("sanitize") ||
    t.includes("validate") ||
    t.includes("external input")
  ) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const hits = lines.filter(
        (l) =>
          /req\.(body|query|params)\.\w+/.test(l.code) &&
          !/validate|sanitize|zod|joi|yup|schema/.test(l.code),
      );
      return hits.length
        ? `Unvalidated request input on line(s) ${hits.map((l) => l.no).join(", ")} — validate/sanitize`
        : null;
    });
  }

  // ── Error Handling ────────────────────────────────────────────────────────────

  if (t.includes("silently swallowed") || t.includes("silent")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const code = lines.map((l) => l.code).join("\n");
      return /catch\s*\([^)]*\)\s*\{\s*(\/\/[^\n]*)?\s*\}/.test(code)
        ? `Empty catch block — errors are being silently swallowed`
        : null;
    });
  }

  if (t.includes("async") && t.includes("error handling")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const hasAwait = lines.some((l) => /\bawait\b/.test(l.code));
      const hasTryCatch = lines.some((l) => /\btry\b/.test(l.code));
      const hasDotCatch = lines.some((l) => /\.catch\s*\(/.test(l.code));
      return hasAwait && !hasTryCatch && !hasDotCatch
        ? `async/await used without try/catch or .catch()`
        : null;
    });
  }

  // ── Testing ───────────────────────────────────────────────────────────────────

  if (t.includes("unit test") || t.includes("corresponding")) {
    checks.push((lines, file, allFiles) => {
      if (!isCodeFile(file) || isTestFile(file)) return null;
      const base = path.basename(file, path.extname(file));
      const hasTest = allFiles.some((f) => isTestFile(f) && f.includes(base));
      return !hasTest && lines.length > 10
        ? `No test file found for \`${path.basename(file)}\` — add unit tests`
        : null;
    });
  }

  if (t.includes("test code") && t.includes("production")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file) || isTestFile(file)) return null;
      // Must look like a real call/import, not a string/comment mention
      const hits = lines.filter(
        (l) =>
          /\b(jest\.fn|vi\.fn|sinon\.(stub|spy|mock)|\.mock\(|\.stub\()\b/.test(
            l.code,
          ) &&
          !/^\s*(\/\/|#|\*)/.test(l.code) &&
          !/['"`].*\b(mock|stub|spy)\b.*['"`]/.test(l.code),
      );
      return hits.length
        ? `Test utilities in non-test file on line(s) ${hits.map((l) => l.no).join(", ")}`
        : null;
    });
  }

  // ── Documentation ─────────────────────────────────────────────────────────────

  if (t.includes("docstring") || t.includes("jsdoc")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const undoc = lines.filter((fl, i) => {
        const isFunc =
          /^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(export\s+)?const\s+\w+\s*=\s*(async\s*)?\(/.test(
            fl.code,
          );
        if (!isFunc) return false;
        const prev = lines[i - 1];
        return !prev || !/\*\/|#|\/\//.test(prev.code);
      });
      return undoc.length
        ? `Function(s) without JSDoc on line(s) ${undoc.map((l) => l.no).join(", ")}`
        : null;
    });
  }

  // ── Performance ───────────────────────────────────────────────────────────────

  if (t.includes("loop") && (t.includes("database") || t.includes("query"))) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const code = lines.map((l) => l.code).join("\n");
      return /(for|while|forEach)\b[\s\S]{0,300}?\b(await\s+\w*(query|find|fetch|select|get)\w*\s*\()/s.test(
        code,
      )
        ? `Possible DB/fetch call inside a loop — N+1 risk`
        : null;
    });
  }

  if (t.includes("o(n²)") || t.includes("nested loop")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const code = lines.map((l) => l.code).join("\n");
      return /for\s*\([\s\S]{0,300}for\s*\(/s.test(code)
        ? `Nested loops detected — verify not an O(n²) algorithm`
        : null;
    });
  }

  // ── Naming ────────────────────────────────────────────────────────────────────

  if (t.includes("single-letter") || t.includes("single letter")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const hits = lines.filter((l) => {
        // Skip loop variables (for, forEach, map, filter, reduce arrow params)
        if (
          /for\s*\(|\.(map|filter|reduce|forEach|find|some|every)\s*\(\s*\(?\s*[a-z]\s*[,)=]/.test(
            l.code,
          )
        )
          return false;
        // Skip single-letter arrow params like (e) =>, (f) =>, (t) =>
        if (/^\s*[.(]?\s*\(?\s*[a-z]\s*\)?\s*=>/.test(l.code)) return false;
        if (/\(\s*[a-z]\s*\)\s*=>/.test(l.code)) return false;
        return /\b(const|let|var)\s+[a-z]\s*=/.test(l.code);
      });
      return hits.length
        ? `Single-letter variable(s) on line(s) ${hits.map((l) => l.no).join(", ")}`
        : null;
    });
  }

  // ── Console logs ──────────────────────────────────────────────────────────────

  if (t.includes("console") || t.includes("debug") || t.includes("print")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file) || isTestFile(file)) return null;
      const hits = lines.filter((l) =>
        /\bconsole\.(log|debug|info|warn|error)\b/.test(l.code),
      );
      return hits.length
        ? `console.log/debug on line(s) ${hits.map((l) => l.no).join(", ")} — remove before merging`
        : null;
    });
  }

  return checks;
}

// ─── File type helpers ────────────────────────────────────────────────────────

const CODE_EXTS = new Set([
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".py",
  ".java",
  ".go",
  ".rb",
  ".php",
  ".cs",
  ".cpp",
  ".c",
  ".swift",
  ".kt",
  ".rs",
]);
const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /__tests__/,
  /\/test\//,
];

function isCodeFile(f) {
  return CODE_EXTS.has(path.extname(f).toLowerCase());
}
function isTestFile(f) {
  return TEST_PATTERNS.some((p) => p.test(f));
}

// ─── Diff parser ──────────────────────────────────────────────────────────────

function parseDiff(diff) {
  const files = {};
  let currentFile = null;
  let lineNo = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      currentFile = raw.slice(6).trim();
      files[currentFile] = files[currentFile] || [];
      continue;
    }
    if (raw.startsWith("@@ ")) {
      const m = raw.match(/@@ \+(\d+)/);
      lineNo = m ? parseInt(m[1]) - 1 : 0;
      continue;
    }
    if (!currentFile) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      lineNo++;
      files[currentFile].push({ no: lineNo, code: raw.slice(1) });
    } else if (!raw.startsWith("-")) {
      lineNo++;
    }
  }
  return files;
}

// ─── Reviewer ─────────────────────────────────────────────────────────────────

function reviewDiff(diff, rules, allChangedFiles) {
  const fileMap = parseDiff(diff);
  const results = [];
  for (const [file, addedLines] of Object.entries(fileMap)) {
    if (!addedLines.length) continue;
    if (!file.startsWith("src/")) continue;
    for (const rule of rules) {
      for (const check of rule.checks) {
        try {
          const msg = check(addedLines, file, allChangedFiles);
          if (msg)
            results.push({
              file,
              category: rule.category,
              rule: rule.text,
              message: msg,
            });
        } catch (_) {
          /* skip broken checker */
        }
      }
    }
  }
  return results;
}

// ─── Reporters ────────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
const col = (k, t) => `${C[k]}${t}${C.reset}`;

function printReport(results, commits, files) {
  console.log("\n" + col("bold", "═".repeat(62)));
  console.log(col("bold", "  🔍  PR Review Report"));
  console.log(col("bold", "═".repeat(62)));
  console.log(col("gray", `  ${new Date().toLocaleString()}`));
  if (commits.length)
    console.log(col("gray", `  Commits : ${commits.slice(0, 3).join(" | ")}`));
  console.log(col("gray", `  Files   : ${files.length} changed`));
  console.log();

  if (!results.length) {
    console.log(col("green", "  ✅  No violations found — looks good!\n"));
    return;
  }

  const byFile = {};
  for (const r of results) (byFile[r.file] = byFile[r.file] || []).push(r);

  for (const [file, issues] of Object.entries(byFile)) {
    console.log(col("cyan", `  📄  ${file}`));
    for (const issue of issues) {
      console.log(
        col("yellow", `     ⚠  [${issue.category}] in ${path.basename(file)}`),
      );
      console.log(col("gray", `        Rule    : ${issue.rule}`));
      console.log(
        `        Finding : [${path.basename(file)}] ${issue.message}`,
      );
      console.log();
    }
  }

  const hasSecurity = results.some((r) => r.category === "Security");
  const verdict = hasSecurity
    ? col("red", "  🚫 REQUEST CHANGES — security issues must be fixed")
    : results.length > 5
      ? col("yellow", "  ⚠️  APPROVE WITH COMMENTS — several issues found")
      : col("yellow", "  ⚠️  APPROVE WITH COMMENTS — minor issues found");

  console.log("─".repeat(62));
  console.log(verdict);
  console.log(col("gray", `  Total violations: ${results.length}`));
  console.log("─".repeat(62) + "\n");
}

function buildMarkdown(results, commits, files, opts) {
  const mode = opts.staged
    ? "Staged changes"
    : opts.base
      ? `diff vs \`${opts.base}\``
      : `last ${opts.commits} commit(s)`;

  const lines = [
    "# 🔍 PR Review Report",
    "",
    `**Generated:** ${new Date().toLocaleString()}  `,
    `**Mode:** ${mode}  `,
    `**Commits:** ${commits.join(", ") || "N/A"}  `,
    `**Files changed:** ${files.length}`,
    "",
    "---",
    "",
  ];

  if (!results.length) {
    lines.push("## ✅ No violations found", "");
    return lines.join("\n");
  }

  lines.push(`## Violations (${results.length} total)`, "");
  const byFile = {};
  for (const r of results) (byFile[r.file] = byFile[r.file] || []).push(r);
  for (const [file, issues] of Object.entries(byFile)) {
    lines.push(`### \`${file}\``, "");
    for (const issue of issues) {
      lines.push(
        `- **[${issue.category}]** \`${path.basename(file)}\` — ${issue.message}`,
      );
      lines.push(`  - *Rule:* ${issue.rule}`, "");
    }
  }

  const hasSecurity = results.some((r) => r.category === "Security");
  lines.push(
    "---",
    "",
    hasSecurity
      ? "## 🚫 Verdict: REQUEST CHANGES"
      : results.length > 5
        ? "## ⚠️ Verdict: APPROVE WITH COMMENTS — several issues"
        : "## ⚠️ Verdict: APPROVE WITH COMMENTS — minor issues",
    "",
  );
  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const opts = parseArgs();

if (!run("git rev-parse --is-inside-work-tree")) {
  console.error("❌  Not inside a git repository.");
  process.exit(1);
}

const rulesRaw = loadRules();
if (!rulesRaw) {
  console.error(
    `❌  '${RULES_FILE}' not found. Place it in your project root.`,
  );
  process.exit(1);
}

const rules = parseRules(rulesRaw);
const ruleCount = rules.reduce((n, r) => n + r.checks.length, 0);
console.log(
  `✅  Loaded ${rules.length} rules (${ruleCount} checks) from ${RULES_FILE}`,
);

const diff = getDiff(opts);
if (!diff) {
  console.log("ℹ️   No changes found to review.");
  process.exit(0);
}

const files = getChangedFiles(opts);
const commits = getCommits(opts);
console.log(`📂  ${files.length} file(s) changed\n🔎  Running checks...\n`);

const results = reviewDiff(diff, rules, files);
printReport(results, commits, files);

const md = buildMarkdown(results, commits, files, opts);
const outFile = opts.output || `pr-review-${Date.now()}.md`;
fs.writeFileSync(outFile, md, "utf8");
console.log(`💾  Report saved to: ${outFile}`);
