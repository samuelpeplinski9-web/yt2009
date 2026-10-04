#!/usr/bin/env python3
# Temporary helper: downloads the 2012-06-22 YouTube Leanback snapshot
# (HTML + CSS + JS + SWF players + images) from the Wayback Machine.
# Runs on a GitHub Actions runner because the dev sandbox cannot reach
# web.archive.org directly. Output goes to 2011leanback_raw/.
import os
import re
import sys
import time
import gzip
import io
import urllib.request
import urllib.parse
import urllib.error

TS = "20120622093607"
START = "http://www.youtube.com/leanback"
OUT = "2011leanback_raw"
UA = ("Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/536.11 "
      "(KHTML, like Gecko) Chrome/20.0.1132.27 Safari/536.11")
MAX_FILES = 400

ASSET_EXT = (".css", ".js", ".swf", ".png", ".gif", ".jpg", ".jpeg", ".ico",
             ".xml", ".json", ".woff", ".ttf", ".eot", ".svg")

visited = set()
queue = []
log = []


def logline(s):
    log.append(s)
    print(s, flush=True)


def fetch_raw(full_url, tries=4):
    last = "?"
    for attempt in range(tries):
        req = urllib.request.Request(full_url, headers={
            "User-Agent": UA,
            "Accept-Encoding": "gzip",
        })
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                data = r.read()
                if r.headers.get("Content-Encoding") == "gzip" or \
                   (data[:2] == b"\x1f\x8b" and not full_url.endswith(".gz")):
                    try:
                        data = gzip.GzipFile(fileobj=io.BytesIO(data)).read()
                    except Exception:
                        pass
                return data, "200"
        except urllib.error.HTTPError as e:
            last = str(e.code)
            if e.code == 404:
                return None, last
            time.sleep(6 * (attempt + 1))
        except Exception as e:
            last = repr(e)
            time.sleep(6 * (attempt + 1))
    return None, last


def fetch(url):
    """try several wayback flavors/timestamps for a url"""
    attempts = []
    for ts in (TS, "20120622", "20120601", "20120801", "2012"):
        attempts.append("https://web.archive.org/web/%sid_/%s" % (ts, url))
    attempts.append("https://web.archive.org/web/%s/%s" % (TS, url))
    for a in attempts:
        data, status = fetch_raw(a)
        if data is not None:
            return data, a
        logline("  try %s -> %s" % (a, status))
    return None, None


def norm(url, base):
    url = url.strip().replace("\\/", "/")
    if url.startswith("//"):
        url = "http:" + url
    elif url.startswith("/"):
        b = urllib.parse.urlparse(base)
        url = "%s://%s%s" % (b.scheme or "http", b.netloc, url)
    elif not url.startswith("http"):
        url = urllib.parse.urljoin(base, url)
    m = re.search(r"web\.archive\.org/web/\d+(?:id_|im_|js_|cs_)?/(https?://.+)", url)
    if m:
        url = m.group(1)
    return url.split("#")[0]


def want(url):
    try:
        p = urllib.parse.urlparse(url)
    except Exception:
        return False
    if p.scheme not in ("http", "https"):
        return False
    host = p.netloc.lower()
    if not any(h in host for h in ("ytimg.com", "youtube.com", "gstatic.com")):
        return False
    return p.path.lower().endswith(ASSET_EXT)


def save_path(url):
    p = urllib.parse.urlparse(url)
    path = p.path.lstrip("/") or "index.html"
    return os.path.join(OUT, p.netloc, path)


def extract(url, data):
    try:
        text = data.decode("utf-8", "replace")
    except Exception:
        return []
    found = set()
    low = url.lower()
    is_html = low.endswith((".html", ".htm")) or "youtube.com/leanback" in low
    if is_html:
        for m in re.findall(r"""(?:src|href)\s*=\s*["']([^"']+)["']""", text):
            found.add(m)
        for m in re.findall(r"""["']((?:https?:)?(?:\\/\\/|//)[a-z0-9.\-]*ytimg\.com[^"'\s]*)["']""", text, re.I):
            found.add(m)
    if low.endswith(".css") or is_html:
        for m in re.findall(r"""url\(\s*['"]?([^'")]+)['"]?\s*\)""", text):
            found.add(m)
    if low.endswith(".js") or is_html:
        for m in re.findall(r"""["']((?:https?:)?(?:\\/\\/|//)?[a-z0-9.\-]*ytimg\.com[^"'\s\\]*\.(?:swf|js|css|png|gif|jpg|xml))["']""", text, re.I):
            found.add(m)
        for m in re.findall(r"""["'](/yt/[a-z0-9_\-./]+\.(?:swf|js|css|png|gif|jpg))["']""", text, re.I):
            found.add("http://s.ytimg.com" + m)
    out = []
    for f in found:
        n = norm(f, url)
        if want(n):
            out.append(n)
    return out


def finish():
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "FETCH_LOG.txt"), "w") as f:
        f.write("\n".join(log) + "\n")


def main():
    os.makedirs(OUT, exist_ok=True)
    html, src = fetch(START)
    if html is None:
        logline("FATAL: could not fetch start page in any flavor")
        finish()
        return
    logline("OK   %s via %s (%d bytes)" % (START, src, len(html)))
    main_path = os.path.join(OUT, "www.youtube.com", "leanback.html")
    os.makedirs(os.path.dirname(main_path), exist_ok=True)
    with open(main_path, "wb") as f:
        f.write(html)
    for u in extract(START + "/index.html", html):
        if u not in visited:
            visited.add(u)
            queue.append((u, 1))
    logline("queued %d assets from main page" % len(queue))

    count = 0
    while queue and count < MAX_FILES:
        url, depth = queue.pop(0)
        time.sleep(0.5)
        data, src = fetch(url)
        count += 1
        if data is None:
            logline("MISS %s" % url)
            continue
        sp = save_path(url)
        os.makedirs(os.path.dirname(sp), exist_ok=True)
        with open(sp, "wb") as f:
            f.write(data)
        logline("OK   %s (%d bytes)" % (url, len(data)))
        if depth < 3 and url.lower().endswith((".css", ".js")):
            for u in extract(url, data):
                if u not in visited:
                    visited.add(u)
                    queue.append((u, depth + 1))

    logline("done: %d fetch attempts" % count)
    finish()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        logline("EXC: " + traceback.format_exc())
        finish()
    sys.exit(0)
