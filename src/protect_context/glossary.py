"""A fixed English/中文 bridge for recall — a dictionary, not embeddings.

A keyword is matched literally across ``text``, ``cmd``, and ``digest``. That
left one measured gap: a 中文 query never reached an English row claiming the
same rule (``生产库`` found nothing in "never run destructive SQL on the
production database") because the two rows share no characters. Real
cross-lingual paraphrase needs a learned model, which SPEC excludes, so this
module does the deterministic half: a curated list of term pairs for the
vocabulary this tool actually records.

What this is:

- **A dictionary lookup, applied at query time.** Nothing is translated when a
  row is stored, so the JSONL format is unchanged and an old store needs no
  migration. The query term is expanded to its counterparts; the row still has
  to contain one of them under the normal word-start/stem rule.
- **Symmetric.** ``生产库`` expands to ``production database`` and
  ``production``; ``deploy`` expands to ``部署``.
- **Bounded and honest.** Only the pairs below bridge. A paraphrase outside
  this table still misses, exactly as before — this is recall for the terms a
  maintainer wrote down, not a translation model. Adding a pair is a one-line
  data change in this file and its TypeScript mirror.

Keep the pairs identical to ``extension/lib/glossary.ts``; both suites pin the
same list, and ``tests/test_recall.py`` parses the TypeScript file so the two
cannot drift silently.
"""

from __future__ import annotations

from . import stem as stemmer

# (English, 中文). English is matched by word start or shared stem, 中文 by
# substring in either direction. Choose terms that are unambiguous in this
# domain: a wrong bridge costs precision the owner has to notice, which is worse
# than a missed paraphrase.
PAIRS: tuple[tuple[str, str], ...] = (
    ("deploy", "部署"),
    ("production", "生产"),
    ("production database", "生产库"),
    ("database", "数据库"),
    ("destructive", "破坏性"),
    ("migration", "迁移"),
    ("delete", "删除"),
    ("rollback", "回滚"),
    ("backup", "备份"),
    ("test", "测试"),
    ("check", "检查"),
    ("verify", "验证"),
    ("audit", "审计"),
    ("review", "审查"),
    ("approve", "批准"),
    ("reject", "拒绝"),
    ("commit", "提交"),
    ("push", "推送"),
    ("branch", "分支"),
    ("merge", "合并"),
    ("release", "发布"),
    ("publish", "发布"),
    ("version", "版本"),
    ("contract", "契约"),
    ("constraint", "约束"),
    ("rule", "规则"),
    ("spec", "规范"),
    ("evidence", "证据"),
    ("session", "会话"),
    ("journal", "日志"),
    ("memory", "记忆"),
    ("recall", "召回"),
    ("search", "检索"),
    ("diff", "差异"),
    ("secret", "密钥"),
    ("token", "令牌"),
    ("password", "密码"),
    ("file", "文件"),
    ("config", "配置"),
    ("store", "存储"),
    ("security", "安全"),
    ("dependency", "依赖"),
    ("install", "安装"),
    ("fix", "修复"),
    ("bug", "缺陷"),
    ("document", "文档"),
    ("network", "网络"),
    ("offline", "离线"),
    ("error", "错误"),
    ("failure", "失败"),
    ("loop", "循环"),
    ("task", "任务"),
    ("plan", "计划"),
    ("report", "报告"),
    ("summary", "摘要"),
    ("clean", "清理"),
    ("code", "代码"),
    ("project", "项目"),
    ("split", "拆分"),
)


def _is_ascii(term: str) -> bool:
    return term.isascii()


def _word_start(haystack: str, keyword: str) -> bool:
    """True when ``keyword`` starts a word in ``haystack`` (ASCII rule)."""
    if not keyword:
        return False
    start = 0
    while True:
        index = haystack.find(keyword, start)
        if index < 0:
            return False
        if index == 0 or not haystack[index - 1].isalnum():
            return True
        start = index + 1


def term_matches(entry: str, keyword: str) -> bool:
    """True when ``keyword`` names the same term as a glossary ``entry`` side.

    Script must agree: a 中文 keyword is matched against the 中文 side only, so
    the lookup is one hop and never chains a translation of a translation.
    """
    entry = entry.casefold()
    keyword = keyword.casefold()
    if not entry or not keyword or _is_ascii(entry) != _is_ascii(keyword):
        return False
    if not _is_ascii(keyword):
        # No word starts in Chinese: substring in either direction, so a query
        # for 生产 also reaches the more specific 生产库 entry.
        return keyword in entry or entry in keyword
    if _word_start(entry, keyword):
        return True
    stemmed = stemmer.stem(entry)
    return stemmed != "" and stemmed == stemmer.stem(keyword)


def translations(keyword: str) -> tuple[str, ...]:
    """Counterparts of ``keyword`` in the other language, in table order.

    The keyword itself is never returned, so a pair whose sides differ only in
    case cannot produce a self-match. A one-character keyword does not bridge:
    Chinese substring matching runs in either direction, so ``库`` would reach
    both ``数据库`` and ``生产库`` and then English rows for each — that is a
    guess, not a lookup. Literal matching is unchanged, so ``库`` still finds
    the Chinese rows that contain it.
    """
    folded = keyword.casefold()
    found: list[str] = []
    seen: set[str] = {folded}
    if len(folded.strip()) < 2:
        return tuple(found)
    for english, chinese in PAIRS:
        if term_matches(english, keyword):
            candidate = chinese
        elif term_matches(chinese, keyword):
            candidate = english
        else:
            continue
        key = candidate.casefold()
        if key in seen:
            continue
        seen.add(key)
        found.append(candidate)
    return tuple(found)
