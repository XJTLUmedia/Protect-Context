#!/usr/bin/env bash
# check-discoverability.sh - does npm/Pi actually surface this package?
#
# The Pi package gallery (pi.dev/packages) builds its catalog from npm search
# results. npm search hides every package whose search score is 0, and the score
# is derived from npm's *lagged* download statistics. A freshly published
# package therefore stays invisible for a few days even though its registry
# metadata is perfect and its detail page renders.
#
# Usage: scripts/check-discoverability.sh [--json] [--package NAME]
# Exit:  0 discoverable, 1 not discoverable (with diagnosis), 2 fetch failure
set -uo pipefail
exec python3 - "$@" <<'PY'
import argparse, html, json, re, subprocess, sys, time, urllib.parse

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
REG = "https://registry.npmjs.org"
SEARCH = REG + "/-/v1/search"
STATS = "https://api.npmjs.org/downloads"
GALLERY = "https://pi.dev/packages"


def fetch(url, tries=6):
    """GET with retries. curl is used because registry.npmjs.org and pi.dev
    both drop some non-browser TLS handshakes (urllib), so retries matter."""
    for attempt in range(tries):
        p = subprocess.run(
            ["curl", "-s", "-m", "30", "--http1.1", "--retry", "1",
             "-A", UA, "-w", "\n%{http_code}", url],
            capture_output=True, text=True)
        if p.returncode == 0:
            body, _, code = p.stdout.rpartition("\n")
            if code.strip() == "200" and body:
                return body
        time.sleep(2)
    return None


def get_json(url):
    body = fetch(url)
    if body is None:
        return None
    try:
        return json.loads(body)
    except ValueError:
        return None


def search(text, size=20):
    return get_json(f"{SEARCH}?size={size}&text=" + urllib.parse.quote(text))


def main():
    ap = argparse.ArgumentParser(description="Check npm + Pi gallery discoverability.")
    ap.add_argument("--package", default="protect-context", help="npm package name")
    ap.add_argument("--json", action="store_true", help="print a JSON summary only")
    ap.add_argument("--reference", default="react",
                    help="busy package used to detect npm download-stats lag")
    args = ap.parse_args()
    pkg = args.package

    rep = {"package": pkg, "metadata_ok": None, "score": None, "weekly": None,
           "rank": None, "stats_lag_days": [], "gallery_hits": None,
           "detail_page": None, "verdict": None, "score_known": False}
    failures = []

    # 1. registry metadata (what a maintainer controls)
    doc = get_json(f"{REG}/{urllib.parse.quote(pkg, safe='@')}")
    if doc is None:
        failures.append("registry")
    else:
        version = doc["dist-tags"]["latest"]
        manifest = doc["versions"][version]
        kw = manifest.get("keywords") or []
        rep.update(version=version, published=doc["time"][version],
                   first_publish=doc["time"].get("created"),
                   keywords=kw, pi_manifest=manifest.get("pi") or None,
                   maintainer=((doc.get("maintainers") or [{}])[0].get("username")
                               or (doc.get("maintainers") or [{}])[0].get("name")),
                   metadata_ok=("pi-package" in kw and bool(manifest.get("pi"))))

    # 2. npm search-index document (score is what the gallery ranks on)
    if rep.get("maintainer"):
        for query in (f"maintainer:{rep['maintainer']}", f"author:{rep['maintainer']}"):
            res = search(query, size=100)
            entry = next((o for o in (res or {}).get("objects", [])
                          if o["package"]["name"] == pkg), None)
            if entry:
                rep.update(score=round(entry["score"]["final"], 2),
                           weekly=entry["downloads"]["weekly"],
                           doc_monthly=entry["downloads"]["monthly"],
                           doc_updated=entry["updated"], score_known=True)
                break

    # 3. does npm search rank the package for its own name?
    res = search(pkg)
    if res is None:
        failures.append("search")
    else:
        names = [o["package"]["name"] for o in res["objects"]]
        rep["rank"] = names.index(pkg) if pkg in names else None

    # 4. npm download stats lag (the search score is computed from these)
    def week(name):
        end = time.gmtime()
        start = time.gmtime(time.time() - 5 * 86400)
        span = (f"{time.strftime('%Y-%m-%d', start)}:"
                f"{time.strftime('%Y-%m-%d', end)}")
        r = get_json(f"{STATS}/range/{span}/{urllib.parse.quote(name, safe='@')}")
        return {d["day"]: d["downloads"] for d in (r or {}).get("downloads", [])}

    ref, mine = week(args.reference), week(pkg)
    if ref:
        scored = [d for d, n in sorted(ref.items()) if n]
        last = scored[-1] if scored else None
        rep["stats_lag_days"] = [d for d in sorted(ref) if last and d > last and not ref[d]]
        rep["stats_last_day"] = last
    if mine:
        rep["week_downloads"] = sum(mine.values())

    # 4b. npm's *own* last-month figure, to test whether the search document
    # above is a stale snapshot: a publish writes the document with whatever
    # the download rollup held at that moment, so publishing before the first
    # rollup pins downloads.monthly at 0 and npm then drops the document from
    # every text query (pi.dev is fed by those queries).
    month = get_json(f"{STATS}/point/last-month/{urllib.parse.quote(pkg, safe='@')}")
    if month is not None and "downloads" in month:
        rep["api_monthly"] = month["downloads"]
        rep["api_monthly_window"] = f"{month.get('start')}..{month.get('end')}"
    rep["doc_downloads_stale"] = (
        (rep.get("doc_monthly") == 0) and (rep.get("api_monthly") or 0) > 0)

    # 4c. can this machine even publish? (decides whether "republish" is advice
    # the caller can act on, or a dead end that needs `npm login` first)
    try:
        who = subprocess.run(["npm", "whoami"], capture_output=True, text=True,
                             timeout=60)
        rep["publish_auth"] = ("ok" if who.returncode == 0
                               else "invalid (npm login)")
    except (OSError, subprocess.SubprocessError):
        rep["publish_auth"] = "unknown (no npm)"

    # 5. the gallery itself: filter results + live detail page
    page = fetch(f"{GALLERY}?name=" + urllib.parse.quote(pkg, safe=""))
    if page is None:
        failures.append("gallery")
    else:
        hits = re.findall(r'data-package-name="' + re.escape(pkg) + r'"',
                          html.unescape(page))
        rep["gallery_hits"] = len(hits)
        rep["no_match"] = "No packages match" in page
    detail = fetch(f"{GALLERY}/{urllib.parse.quote(pkg, safe='')}")
    if detail is not None:
        m = re.search(r"Downloads\s*</[^>]*>\s*<[^>]*>\s*([^<]{1,40})", detail)
        rep["detail_page"] = (m.group(1).strip() if m else "renders")

    # verdict: does npm have download data for any day since this package existed?
    first, stats_end = rep.get("first_publish"), rep.get("stats_last_day")
    if first and stats_end and stats_end < first[:10]:
        rep["stats_behind_publish"] = True
        rep["recheck_after"] = time.strftime(
            "%Y-%m-%d", time.localtime(
                time.mktime(time.strptime(first[:10], "%Y-%m-%d")) + 3 * 86400))

    if rep["metadata_ok"] is False:
        rep["verdict"] = "metadata"
    elif rep["gallery_hits"]:
        rep["verdict"] = "listed"
    elif rep["score_known"] and not rep["score"]:
        if rep.get("stats_behind_publish"):
            rep["verdict"] = "wait-stats"
        elif rep["doc_downloads_stale"]:
            rep["verdict"] = ("stale-doc" if rep.get("publish_auth") == "ok"
                              else "stale-doc-needs-login")
        else:
            rep["verdict"] = "republish"
    elif rep["rank"] == 0:
        rep["verdict"] = "gallery-lag"
    elif failures:
        rep["verdict"] = "fetch-failed:" + ",".join(failures)
    else:
        rep["verdict"] = "search-lag"

    if args.json:
        print(json.dumps(rep, indent=1))
    else:
        print(f"package            : {pkg} {rep.get('version', '?')} "
              f"(this version {rep.get('published', '?')[:19]}, "
              f"first published {rep.get('first_publish', '?')[:19]})")
        print(f"registry metadata  : pi-package keyword={rep.get('keywords')} "
              f"pi manifest={rep.get('pi_manifest')} -> "
              f"{'OK' if rep['metadata_ok'] else 'PROBLEM'}")
        print(f"npm search score   : {rep['score']} "
              f"(weekly downloads {rep['weekly']}, "
              f"ranked #{rep['rank']} for its own name)")
        print(f"npm stats lag      : stats end {rep.get('stats_last_day')}, "
              f"not rolled up yet: {rep['stats_lag_days'] or 'none'}; "
              f"this package's downloads in the last 5 days: {rep.get('week_downloads')}")
        if rep.get("stats_behind_publish"):
            print(f"                     -> npm holds no download data for any day "
                  f"since this package existed; next re-check {rep['recheck_after']}")
        print(f"pi.dev gallery     : {rep['gallery_hits']} hit(s)"
              f"{', \"No packages match\"' if rep.get('no_match') else ''}; "
              f"detail page downloads: {rep['detail_page']}")
        print(f"search document    : downloads.monthly={rep.get('doc_monthly')} "
              f"updated {str(rep.get('doc_updated'))[:19]}; npm reports "
              f"{rep.get('api_monthly')} for {rep.get('api_monthly_window')} -> "
              f"{'STALE' if rep['doc_downloads_stale'] else 'consistent'}")
        print(f"publish auth       : {rep.get('publish_auth')}")
        print()
        hints = {
            "listed": "Listed. Nothing to do.",
            "metadata": "Fix package.json: keywords must include 'pi-package' and the "
                        "'pi' manifest must exist, then republish.",
            "score-zero": "npm search score is 0, so no npm query ranks the package "
                          "and the gallery index (built from npm search) skips it. "
                          "Republish after the stats window advances.",
            "wait-stats": "Do NOT publish yet: npm has no download data for any day "
                          "since this package was first published, so a republish now "
                          "would write another score-0 document. Wait for the stats "
                          f"rollup, re-check from {rep.get('recheck_after')}, then "
                          "publish a patch release to force npm to re-write the "
                          "search document.",
            "republish": "npm's stats already cover days after the first publish, but "
                         "the search document still scores 0. Publish a patch release "
                         "to force npm to re-write it.",
            "stale-doc": "The search document was written while npm's download rollup "
                         f"was still empty (it says 0, npm reports "
                         f"{rep.get('api_monthly')}), and npm hides zero-download "
                         "documents from every text query. Publish a patch release: "
                         "the new document records the current downloads and starts "
                         "ranking. npm re-crawls documents on its own too, so "
                         "re-running later also works.",
            "stale-doc-needs-login": "Same stale document, but this machine cannot "
                                     "publish (`npm whoami` fails): the token is "
                                     "missing or expired. Run `npm login` (or set a "
                                     "granular token with read+write), then publish a "
                                     "patch release; or wait for npm's own re-crawl.",
            "gallery-lag": "npm search already ranks it #1; the gallery catalog "
                           "refresh is behind. Re-check in a few hours.",
            "search-lag": "npm holds a search document but does not rank the package. "
                          "Publish a patch release to force a re-write.",
        }
        print("verdict            : " + rep["verdict"])
        print("next step          : " + hints.get(
            rep["verdict"], "Re-run later; network fetches failed."))

    return 0 if rep["verdict"] == "listed" else (2 if failures else 1)


sys.exit(main())
PY
