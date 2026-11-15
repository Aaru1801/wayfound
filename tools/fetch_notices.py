#!/usr/bin/env python3
"""Snapshot U of T's Building Access Notices (entrance and elevator disruptions).

The notices site is a paginated HTML table. This saves every listed notice
(title, from/to dates, link, active flag) plus the body text of active ones,
so build_campus.py can attach them to buildings.

Usage: fetch_notices.py OUT_JSON [max_pages]
"""
import datetime
import html
import json
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://notices.aoda.utoronto.ca/browse/"
USER_AGENT = "campus-access-map-prototype/1.0"
ROW = re.compile(r"<tr>(.*?)</tr>", re.S)
DATES = re.compile(r"(\d{4}-[A-Za-z]{3}-\d{2})\s*<br\s*/?>\s*(\d{4}-[A-Za-z]{3}-\d{2})")
LINK = re.compile(r'class="notice-title">\s*<a href="([^"]+)">\s*(.*?)\s*</a>', re.S)


def get(url, attempts=3):
    last_error = None
    for _ in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=40) as response:
                return response.read().decode("utf-8", "replace")
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
    raise RuntimeError(f"{url} failed after {attempts} attempts: {last_error}")


def iso(date_text):
    return datetime.datetime.strptime(date_text, "%Y-%b-%d").date().isoformat()


def parse_rows(page):
    rows = []
    for block in ROW.findall(page):
        dates, link = DATES.search(block), LINK.search(block)
        if not dates or not link:
            continue
        rows.append({
            "title": re.sub(r"\s+", " ", html.unescape(link.group(2))).strip(),
            "from": iso(dates.group(1)), "to": iso(dates.group(2)),
            "url": link.group(1), "active": "Currently Active Notice" in block,
        })
    return rows


def body_text(url, title):
    """Plain text of a notice page between its heading and the footer."""
    page = re.sub(r"<script.*?</script>|<style.*?</style>|<!--.*?-->", "", get(url), flags=re.S)
    lines = [ln.strip() for ln in html.unescape(re.sub(r"<[^>]+>", "\n", page)).split("\n") if ln.strip()]
    starts = [i for i, ln in enumerate(lines) if ln == title]
    if not starts:
        return ""
    body = []
    for ln in lines[starts[-1] + 1:]:
        if ln.startswith("©") or len(" ".join(body)) > 600:
            break
        body.append(ln)
    return " ".join(body[:-1] if len(body) > 1 else body)  # last line repeats the building name


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    first = get(BASE)
    total = re.search(r"Page 1 of (\d+)", first)
    pages = int(total.group(1)) if total else 1
    if len(sys.argv) > 2:
        pages = min(pages, int(sys.argv[2]))
    with ThreadPoolExecutor(6) as pool:
        later = list(pool.map(lambda n: get(f"{BASE}page/{n}/"), range(2, pages + 1)))
    notices, seen = [], set()
    for page in [first] + later:
        for row in parse_rows(page):
            if row["url"] not in seen:
                seen.add(row["url"])
                notices.append(row)
    if not notices:
        sys.exit("no notices parsed: the page layout may have changed")
    for notice in notices:
        if notice["active"]:
            notice["text"] = body_text(notice["url"], notice["title"])
    snapshot = datetime.datetime.now().astimezone().isoformat(timespec="minutes")
    with open(sys.argv[1], "w") as out:
        json.dump({"source": BASE, "snapshot": snapshot, "pages": pages, "notices": notices}, out, ensure_ascii=False, indent=1)
    print(f"{len(notices)} notices from {pages} pages; {sum(n['active'] for n in notices)} active; snapshot {snapshot}")


if __name__ == "__main__":
    main()
