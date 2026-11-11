/**
 * A fixed English/中文 bridge for recall — a dictionary, not embeddings.
 *
 * A keyword is matched literally across `text`, `cmd`, and `digest`. That left
 * one measured gap: a 中文 query never reached an English row claiming the same
 * rule (`生产库` found nothing in "never run destructive SQL on the production
 * database") because the two rows share no characters. Real cross-lingual
 * paraphrase needs a learned model, which SPEC excludes, so this module does the
 * deterministic half: a curated list of term pairs for the vocabulary this tool
 * actually records.
 *
 * - A dictionary lookup, applied at query time. Nothing is translated when a row
 *   is stored, so the JSONL format is unchanged and an old store needs no
 *   migration.
 * - Symmetric: `生产库` expands to `production database` and `production`;
 *   `deploy` expands to `部署`.
 * - Bounded and honest: only the pairs below bridge. A paraphrase outside this
 *   table still misses, exactly as before.
 *
 * The pairs must stay identical to `src/protect_context/glossary.py`; a Python
 * test parses this file so the two cannot drift silently.
 */

import { stem } from "./stem.ts";

/** (English, 中文). English matches by word start or shared stem; 中文 by substring. */
export const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["deploy", "部署"],
  ["production", "生产"],
  ["production database", "生产库"],
  ["database", "数据库"],
  ["destructive", "破坏性"],
  ["migration", "迁移"],
  ["delete", "删除"],
  ["rollback", "回滚"],
  ["backup", "备份"],
  ["test", "测试"],
  ["check", "检查"],
  ["verify", "验证"],
  ["audit", "审计"],
  ["review", "审查"],
  ["approve", "批准"],
  ["reject", "拒绝"],
  ["commit", "提交"],
  ["push", "推送"],
  ["branch", "分支"],
  ["merge", "合并"],
  ["release", "发布"],
  ["publish", "发布"],
  ["version", "版本"],
  ["contract", "契约"],
  ["constraint", "约束"],
  ["rule", "规则"],
  ["spec", "规范"],
  ["evidence", "证据"],
  ["session", "会话"],
  ["journal", "日志"],
  ["memory", "记忆"],
  ["recall", "召回"],
  ["search", "检索"],
  ["diff", "差异"],
  ["secret", "密钥"],
  ["token", "令牌"],
  ["password", "密码"],
  ["file", "文件"],
  ["config", "配置"],
  ["store", "存储"],
  ["security", "安全"],
  ["dependency", "依赖"],
  ["install", "安装"],
  ["fix", "修复"],
  ["bug", "缺陷"],
  ["document", "文档"],
  ["network", "网络"],
  ["offline", "离线"],
  ["error", "错误"],
  ["failure", "失败"],
  ["loop", "循环"],
  ["task", "任务"],
  ["plan", "计划"],
  ["report", "报告"],
  ["summary", "摘要"],
  ["clean", "清理"],
  ["code", "代码"],
  ["project", "项目"],
  ["split", "拆分"],
];

/** True for a keyword with no non-ASCII character (the ASCII rule's domain). */
function isAscii(term: string): boolean {
  return /^[\x00-\x7F]*$/.test(term);
}

/** True when `keyword` starts a word in `haystack` (same rule as recall.wordHit). */
function wordStart(haystack: string, keyword: string): boolean {
  if (keyword === "") return false;
  let start = 0;
  for (;;) {
    const idx = haystack.indexOf(keyword, start);
    if (idx < 0) return false;
    if (idx === 0) return true;
    const prior = Array.from(haystack.slice(0, idx)).at(-1);
    if (prior === undefined || !/^[\p{L}\p{N}]$/u.test(prior)) return true;
    start = idx + 1;
  }
}

/**
 * True when `keyword` names the same term as a glossary `entry` side.
 *
 * Script must agree: a 中文 keyword is matched against the 中文 side only, so the
 * lookup is one hop and never chains a translation of a translation.
 */
export function termMatches(entry: string, keyword: string): boolean {
  const foldedEntry = entry.toLowerCase();
  const foldedKeyword = keyword.toLowerCase();
  if (foldedEntry === "" || foldedKeyword === "" || isAscii(foldedEntry) !== isAscii(foldedKeyword)) {
    return false;
  }
  if (!isAscii(foldedKeyword)) {
    // No word starts in Chinese: substring in either direction, so 生产 also
    // reaches the more specific 生产库 entry.
    return foldedKeyword.includes(foldedEntry) || foldedEntry.includes(foldedKeyword);
  }
  if (wordStart(foldedEntry, foldedKeyword)) return true;
  const stemmed = stem(foldedEntry);
  return stemmed !== "" && stemmed === stem(foldedKeyword);
}

/**
 * Counterparts of `keyword` in the other language, in table order.
 *
 * The keyword itself is never returned, so a pair whose sides differ only in
 * case cannot produce a self-match.
 */
export function translationsOf(keyword: string): string[] {
  const folded = keyword.toLowerCase();
  const found: string[] = [];
  const seen = new Set([folded]);
  for (const [english, chinese] of PAIRS) {
    let candidate: string;
    if (termMatches(english, keyword)) candidate = chinese;
    else if (termMatches(chinese, keyword)) candidate = english;
    else continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(candidate);
  }
  return found;
}
