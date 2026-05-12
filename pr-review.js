#!/usr/bin/env node
/**
 * pr-review.js — Rule-based local PR reviewer (no AI, no API key)
 * Parses .pr-review-rules.md and checks your git diff against each rule.
 *
 * Usage:
 *   node pr-review.js                   # review last commit
 *   node pr-review.js --commits 3       # review last 3 commits
 *   node pr-review.js --base main       # review diff against a base branch
 *   node pr-review.js --staged          # review only staged changes
 *   node pr-review.js --output out.md   # save report to file
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { commits: 1, base: null, staged: false, output: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--commits" && args[i + 1]) opts.commits = parseInt(args[++i]);
    if (args[i] === "--base"    && args[i + 1]) opts.base    = args[++i];
    if (args[i] === "--staged")                  opts.staged  = true;
    if (args[i] === "--output"  && args[i + 1]) opts.output  = args[++i];
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
  try { return execSync(cmd, { encoding: "utf8" }).trim(); }
  catch { return ""; }
}

function getDiff(opts) {
  if (opts.staged)  return run("git diff --cached");
  if (opts.base)    return run(`git diff ${opts.base}...HEAD`);
  return run(`git diff HEAD~${opts.commits} HEAD`);
}

function getChangedFiles(opts) {
  if (opts.staged)  return run("git diff --cached --name-only").split("\n").filter(Boolean);
  if (opts.base)    return run(`git diff ${opts.base}...HEAD --name-only`).split("\n").filter(Boolean);
  return run(`git diff HEAD~${opts.commits} HEAD --name-only`).split("\n").filter(Boolean);
}

function getCommits(opts) {
  if (opts.staged) return ["(staged changes — not yet committed)"];
  if (opts.base)   return run(`git log ${opts.base}...HEAD --oneline`).split("\n").filter(Boolean);
  return run(`git log -${opts.commits} --oneline`).split("\n").filter(Boolean);
}

// ─── Rules loader ─────────────────────────────────────────────────────────────

const RULES_FILE = ".pr-review-rules.md";

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

/**
 * Parse rules markdown into array of { category, text, checks[] }
 * Each bullet under a ## heading becomes one rule.
 */
function parseRules(md) {
  const rules = [];
  let category = "General";
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("## ")) { category = line.slice(3).trim(); continue; }
    if (line.startsWith("# "))  { category = line.slice(2).trim(); continue; }
    if (!line.startsWith("- ") && !line.startsWith("* ")) continue;
    const text = line.slice(2).trim();
    rules.push({ category, text, checks: buildChecks(category, text) });
  }
  return rules;
}

// ─── Rule → checker mapping ───────────────────────────────────────────────────

/**
 * Each checker: (addedLines, file, allFiles) => violation string | null
 * addedLines: [{no, code}]
 */
function buildChecks(category, text) {
  const t = text.toLowerCase();
  const checks = [];

  // ── Code Quality ─────────────────────────────────────────────────────────────

  if (t.includes("magic number") || t.includes("magic string")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const hits = lines.filter(l =>
        /(?<![a-zA-Z0-9_'"`])\d{2,}(?![a-zA-Z0-9_'"`])/.test(l.code) &&
        !/^\s*(\/\/|#|\*)/.test(l.code)
      );
      return hits.length
        ? `Magic numbers on line(s) ${hits.map(l => l.no).join(", ")} — use named constants`
        : null;
    });
  }

  if (t.includes("dead code") || t.includes("commented-out") || t.includes("unused import")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const hits = lines.filter(l =>
        /^\s*(\/\/|#)\s*(import |require\(|def |function |const |let |var )/.test(l.code)
      );
      return hits.length
        ? `Commented-out code on line(s) ${hits.map(l => l.no).join(", ")} — remove before merging`
        : null;
    });
  }

  if (t.includes("40 lines") || t.includes("longer than")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      return lines.length > 40
        ? `${lines.length} lines added in one block — check that no single function exceeds 40 lines`
        : null;
    });
  }

  if (t.includes("deeply nested") || t.includes("3 levels")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const deep = lines.filter(l => {
        const m = l.code.match(/^(\s+)/);
        return m && m[1].length >= 12;
      });
      return deep.length
        ? `Deeply nested code (3+ levels) on line(s) ${deep.map(l => l.no).join(", ")}`
        : null;
    });
  }

  // ── Security ──────────────────────────────────────────────────────────────────

  if (
    t.includes("hardcoded secret") || t.includes("api key") ||
    t.includes("password") || t.includes("token")
  ) {
    checks.push((lines) => {
      const patterns = [
        /(?:api[_-]?key|apikey|secret|password|passwd|token|auth)\s*[:=]\s*['"`][^'"`]{6,}/i,
        /sk-[a-zA-Z0-9]{20,}/,
        /ghp_[a-zA-Z0-9]{30,}/,
        /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
      ];
      const hits = lines.filter(l => patterns.some(p => p.test(l.code)));
      return hits.length
        ? `⚠️  Possible hardcoded secret on line(s) ${hits.map(l => l.no).join(", ")}`
        : null;
    });
  }

  if (t.includes("eval") || t.includes("exec")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const hits = lines.filter(l =>
        /\beval\s*\(|\bexec\s*\(/.test(l.code) && !/^\s*(\/\/|#)/.test(l.code)
      );
      return hits.length
        ? `Dangerous eval/exec on line(s) ${hits.map(l => l.no).join(", ")}`
        : null;
    });
  }

  if (t.includes("dangerouslysetinnerhtml")) {
    checks.push((lines) => {
      const hits = lines.filter(l => /dangerouslySetInnerHTML/.test(l.code));
      return hits.length
        ? `dangerouslySetInnerHTML on line(s) ${hits.map(l => l.no).join(", ")} — ensure it's justified`
        : null;
    });
  }

  if (t.includes("sanitize") || t.includes("validate") || t.includes("external input")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const hits = lines.filter(l =>
        /req\.(body|query|params)\.\w+/.test(l.code) &&
        !/validate|sanitize|zod|joi|yup|schema/.test(l.code)
      );
      return hits.length
        ? `Unvalidated request input on line(s) ${hits.map(l => l.no).join(", ")} — validate/sanitize`
        : null;
    });
  }

  // ── Error Handling ────────────────────────────────────────────────────────────

  if (t.includes("silently swallowed") || t.includes("silent")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const code = lines.map(l => l.code).join("\n");
      return /catch\s*\([^)]*\)\s*\{\s*(\/\/[^\n]*)?\s*\}/.test(code)
        ? `Empty catch block — errors are being silently swallowed`
        : null;
    });
  }

  if (t.includes("async") && t.includes("error handling")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const hasAwait    = lines.some(l => /\bawait\b/.test(l.code));
      const hasTryCatch = lines.some(l => /\btry\b/.test(l.code));
      const hasDotCatch = lines.some(l => /\.catch\s*\(/.test(l.code));
      return hasAwait && !hasTryCatch && !hasDotCatch
        ? `async/await used without try/catch or .catch() — add error handling`
        : null;
    });
  }

  // ── Testing ───────────────────────────────────────────────────────────────────

  if (t.includes("unit test") || t.includes("corresponding")) {
    checks.push((lines, file, allFiles) => {
      if (!isCodeFile(file) || isTestFile(file)) return null;
      const base = path.basename(file, path.extname(file));
      const hasTest = allFiles.some(f => isTestFile(f) && f.includes(base));
      return !hasTest && lines.length > 10
        ? `No test file found for \`${path.basename(file)}\` — add unit tests`
        : null;
    });
  }

  if (t.includes("test code") && t.includes("production")) {
    checks.push((lines, file) => {
      if (isTestFile(file)) return null;
      const hits = lines.filter(l => /\b(mock|stub|spy|sinon|jest\.fn|vi\.fn)\b/.test(l.code));
      return hits.length
        ? `Test utilities (mock/stub/spy) in non-test file on line(s) ${hits.map(l => l.no).join(", ")}`
        : null;
    });
  }

  // ── Documentation ─────────────────────────────────────────────────────────────

  if (t.includes("docstring") || t.includes("jsdoc")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const undoc = lines.filter((fl, i) => {
        const isFunc = /^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(export\s+)?const\s+\w+\s*=\s*(async\s*)?\(/.test(fl.code);
        if (!isFunc) return false;
        const prev = lines[i - 1];
        return !prev || !/\*\/|#|\/\//.test(prev.code);
      });
      return undoc.length
        ? `Function(s) without JSDoc/docstring on line(s) ${undoc.map(l => l.no).join(", ")}`
        : null;
    });
  }

  // ── Performance ───────────────────────────────────────────────────────────────

  if (t.includes("loop") && (t.includes("database") || t.includes("query"))) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const code = lines.map(l => l.code).join("\n");
      return /(for|while|forEach)\b[\s\S]{0,300}?\b(await\s+\w*(query|find|fetch|select|get)\w*\s*\()/s.test(code)
        ? `Possible DB/fetch call inside a loop — N+1 risk, move queries outside loops`
        : null;
    });
  }

  if (t.includes("o(n²)") || t.includes("nested loop")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const code = lines.map(l => l.code).join("\n");
      return /for\s*\([\s\S]{0,300}for\s*\(/s.test(code) || /forEach[\s\S]{0,300}forEach/s.test(code)
        ? `Nested loops detected — verify this isn't an O(n²) algorithm`
        : null;
    });
  }

  // ── Naming ────────────────────────────────────────────────────────────────────

  if (t.includes("single-letter") || t.includes("single letter")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file)) return null;
      const hits = lines.filter(l =>
        /\b(const|let|var)\s+[a-z]\s*=/.test(l.code) && !/for\s*\(/.test(l.code)
      );
      return hits.length
        ? `Single-letter variable(s) on line(s) ${hits.map(l => l.no).join(", ")} — use descriptive names`
        : null;
    });
  }

  // ── Console / debug ───────────────────────────────────────────────────────────
  // (Bonus: catches leftover debug statements even if not in rules)

  if (t.includes("console") || t.includes("debug") || t.includes("print")) {
    checks.push((lines, file) => {
      if (!isCodeFile(file) || isTestFile(file)) return null;
      const hits = lines.filter(l => /\bconsole\.(log|debug|info|warn|error)\b/.test(l.code));
      return hits.length
        ? `console.log/debug on line(s) ${hits.map(l => l.no).join(", ")} — remove before merging`
        : null;
    });
  }

  return checks;
}

// ─── File type helpers ────────────────────────────────────────────────────────

const CODE_EXTS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".py", ".java",
  ".go", ".rb", ".php", ".cs", ".cpp", ".c", ".swift", ".kt", ".rs",
]);
const TEST_PATTERNS = [/\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /__tests__/, /\/test\//];

function isCodeFile(f) { return CODE_EXTS.has(path.extname(f).toLowerCase()); }
function isTestFile(f)  { return TEST_PATTERNS.some(p => p.test(f)); }

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
    for (const rule of rules) {
      for (const check of rule.checks) {
        try {
          const msg = check(addedLines, file, allChangedFiles);
          if (msg) results.push({ file, category: rule.category, rule: rule.text, message: msg });
        } catch (_) { /* skip checker errors */ }
      }
    }
  }
  return results;
}

// ─── Reporters ────────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", gray: "\x1b[90m",
};
const col = (k, t) => `${C[k]}${t}${C.reset}`;

function printReport(results, commits, files) {
  console.log("\n" + col("bold", "═".repeat(62)));
  console.log(col("bold", "  🔍  PR Review Report"));
  console.log(col("bold", "═".repeat(62)));
  console.log(col("gray", `  ${new Date().toLocaleString()}`));
  if (commits.length) console.log(col("gray", `  Commits : ${commits.slice(0, 3).join(", ")}`));
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
      console.log(col("yellow", `     ⚠  [${issue.category}]`));
      console.log(col("gray",   `        Rule    : ${issue.rule}`));
      console.log(`        Finding : ${issue.message}`);
      console.log();
    }
  }

  const hasSecurityIssues = results.some(r => r.category === "Security");
  const verdict = hasSecurityIssues
    ? col("red",    "  🚫 REQUEST CHANGES — security issues must be fixed")
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
    "# 🔍 PR Review Report", "",
    `**Generated:** ${new Date().toLocaleString()}  `,
    `**Mode:** ${mode}  `,
    `**Commits:** ${commits.join(", ") || "N/A"}  `,
    `**Files changed:** ${files.length}`, "",
    "---", "",
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
      lines.push(`- **[${issue.category}]** ${issue.message}`);
      lines.push(`  - *Rule:* ${issue.rule}`, "");
    }
  }

  const hasSecurityIssues = results.some(r => r.category === "Security");
  lines.push("---", "");
  lines.push(hasSecurityIssues
    ? "## 🚫 Verdict: REQUEST CHANGES — security issues must be fixed"
    : results.length > 5
    ? "## ⚠️ Verdict: APPROVE WITH COMMENTS — several issues found"
    : "## ⚠️ Verdict: APPROVE WITH COMMENTS — minor issues found");
  lines.push("");
  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs();

  if (!run("git rev-parse --is-inside-work-tree")) {
    console.error("❌  Not inside a git repository.");
    process.exit(1);
  }

  const rulesRaw = loadRules();
  if (!rulesRaw) {
    console.error(`❌  '${RULES_FILE}' not found. Place it in your project root.`);
    process.exit(1);
  }

  const rules = parseRules(rulesRaw);
  const ruleCount = rules.reduce((n, r) => n + r.checks.length, 0);
  console.log(`✅  Loaded ${rules.length} rules (${ruleCount} checks) from ${RULES_FILE}`);

  const diff = getDiff(opts);
  if (!diff) {
    console.log("ℹ️   No changes found to review.");
    process.exit(0);
  }

  const files   = getChangedFiles(opts);
  const commits = getCommits(opts);

  console.log(`📂  ${files.length} file(s) changed`);
  console.log("🔎  Running checks...\n");

  const results = reviewDiff(diff, rules, files);

  printReport(results, commits, files);

  const md      = buildMarkdown(results, commits, files, opts);
  const outFile = opts.output || `pr-review-${Date.now()}.md`;
  fs.writeFileSync(outFile, md, "utf8");
  console.log(`💾  Report saved to: ${outFile}`);
}

main();
