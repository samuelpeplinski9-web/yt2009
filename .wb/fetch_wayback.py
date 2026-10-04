#!/usr/bin/env python3
# Temporary helper: downloads the 2012-06-22 YouTube Leanback snapshot
# (HTML + CSS + JS + SWF players + images) from the Wayback Machine.
# Runs on a GitHub Actions runner because the dev sandbox cannot reach
# web.archive.org directly. Output goes to 2011leanback_raw/.
import os
import re
import sys
import time
import urllib.request
import urllib.parse
import urllib.error

TS = "20120622093607"
START = "http://www.youtube.com/leanback"
OUT = "2011leanback_raw"
UA = ("Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/536.11 "
      "(KHTML, like Gecko) Chrome/20.0.1132.27 Safari/536.11")
MAX_FILES = 400

TEXT_EXT = (".html", ".htm", ".css", ".js", ".xml", ".json")
ASSET_EXT = (".css", ".js", ".swf", ".png", ".gif", ".jpg", ".jpeg", ".ico",
             ".xml", ".json", ".woff", ".ttf", ".eot", ".svg", ".mp4", ".webm")

visited = set()
queue = []
log = []


def wb_url(url):
    return "https://web.archive.org/web/%sid_/%s" % (TS, url)


def fetch(url, tries=6):
    req = urllib.request.Request(wb_url(url), headers={"User-Agent": UA})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            # 429/5xx -> back off
            time.sleep(8 * (attempt + 1))
        except Exception:
            time.sleep(8 * (attempt + 1))
    return None


def norm(url, base):
    url = url.strip()
    # unescape JS-escaped slashes
    url = url.replace("\\/", "/")
    if url.startswith("//"):
        url = "http:" + url
    elif url.startswith("/"):
        b = urllib.parse.urlparse(base)
        url = "%s://%s%s" % (b.scheme, b.netloc, url)
    elif not url.startswith("http"):
        url = urllib.parse.urljoin(base, url)
    # strip wayback prefixes if any leaked through
    m = re.search(r"web\.archive\.org/web/\d+(?:id_|im_|js_|cs_)?/(https?://.+)", url)
    if m:
        url = m.group(1)
    url = url.split("#")[0]
    return url


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
    path = p.path.lower()
    return path.endswith(ASSET_EXT)


def save_path(url):
    p = urllib.parse.urlparse(url)
    path = p.path.lstrip("/")
    if not path:
        path = "index.html"
    return os.path.join(OUT, p.netloc, path)


def extract(url, data):
    """pull referenced asset urls out of html/css/js text"""
    try:
        text = data.decode("utf-8", "replace")
    except Exception:
        return []
    found = set()
    low = url.lower()
    if low.endswith((".html", ".htm")) or "youtube.com/leanback" in low:
        for m in re.findall(r"""(?:src|href)\s*=\s*["']([^"']+)["']""", text):
            found.add(m)
        for m in re.findall(r"""["']((?:https?:)?(?:\\/\\/|//)[a-z0-9.\-]*ytimg\.com[^"'\s]*)["']""", text, re.I):
            found.add(m)
        for m in re.findall(r"""["'](\/\/?[a-z0-9_\-./]+\.(?:swf|js|css|png|gif|jpg))["']""", text, re.I):
            found.add(m)
    if low.endswith(".css"):
        for m in re.findall(r"""url\(\s*['"]?([^'")]+)['"]?\s*\)""", text):
            found.add(m)
    if low.endswith(".js"):
        for m in re.findall(r"""["']((?:https?:)?(?:\\/\\/|//)?[a-z0-9.\-]*(?:s\.ytimg\.com|ytimg\.com)[^"'\s\\]*\.(?:swf|js|css|png|gif|jpg|xml))["']""", text, re.I):
            found.add(m)
        for m in re.findall(r"""["'](/yt/[a-z0-9_\-./]+\.(?:swf|js|css|png|gif|jpg))["']""", text, re.I):
            found.add("http://s.ytimg.com" + m)
    out = []
    for f in found:
        n = norm(f, url)
        if want(n):
            out.append(n)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    # main document
    html = fetch(START)
    if html is None:
        print("FATAL: could not fetch start page", file=sys.stderr)
        sys.exit(1)
    main_path = os.path.join(OUT, "www.youtube.com", "leanback.html")
    os.makedirs(os.path.dirname(main_path), exist_ok=True)
    with open(main_path, "wb") as f:
        f.write(html)
    log.append("OK   %s" % START)
    for u in extract(START + "/index.html", html):
        if u not in visited:
            visited.add(u)
            queue.append((u, 1))

    count = 0
    while queue and count < MAX_FILES:
        url, depth = queue.pop(0)
        time.sleep(0.6)
        data = fetch(url)
        count += 1
        if data is None:
            log.append("MISS %s" % url)
            continue
        sp = save_path(url)
        os.makedirs(os.path.dirname(sp), exist_ok=True)
        with open(sp, "wb") as f:
            f.write(data)
        log.append("OK   %s (%d bytes)" % (url, len(data)))
        if depth < 3 and url.lower().endswith((".css", ".js")):
            for u in extract(url, data):
                if u not in visited:
                    visited.add(u)
                    queue.append((u, depth + 1))

    with open(os.path.join(OUT, "FETCH_LOG.txt"), "w") as f:
        f.write("\n".join(log) + "\n")
    print("\n".join(log))
    print("done: %d files" % count)


if __name__ == "__main__":
    main()
