#!/usr/bin/env python3
# Temporary helper: downloads the 2012-06-22 YouTube Leanback core assets
# from the Wayback Machine on a GitHub Actions runner (the dev sandbox
# cannot reach web.archive.org). Resumable: skips files that already
# exist, commits+pushes after every successful download.
import os
import re
import sys
import time
import gzip
import io
import subprocess
import urllib.request
import urllib.parse
import urllib.error

TS = "20120622093607"
OUT = "2011leanback_raw"
UA = ("Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/536.11 "
      "(KHTML, like Gecko) Chrome/20.0.1132.27 Safari/536.11")
DEADLINE = time.time() + 5 * 3600  # stay under the 6h job cap

# (url, save_path_relative_to_OUT)
SEEDS = [
    ("http://www.gstatic.com/youtube/leanback/3f68892c/javascript/tv-html5.js",
     "www.gstatic.com/youtube/leanback/3f68892c/javascript/tv-html5.js"),
    ("http://www.gstatic.com/youtube/leanback/3f68892c/stylesheet/tv-html5.css",
     "www.gstatic.com/youtube/leanback/3f68892c/stylesheet/tv-html5.css"),
    ("http://s.ytimg.com/yt/jsbin/html5player-vflBfju3R.js",
     "s.ytimg.com/yt/jsbin/html5player-vflBfju3R.js"),
    ("http://s.ytimg.com/yt/cssbin/www-player-vfltUaqw8.css",
     "s.ytimg.com/yt/cssbin/www-player-vfltUaqw8.css"),
    ("http://s.ytimg.com/yt/swfbin/watch_as3-vflTL1Rpm.swf",
     "s.ytimg.com/yt/swfbin/watch_as3-vflTL1Rpm.swf"),
    ("http://s.ytimg.com/yt/swfbin/cps-vflDeURDJ.swf",
     "s.ytimg.com/yt/swfbin/cps-vflDeURDJ.swf"),
    ("http://s.ytimg.com/yt/img/pixel-vfl3z5WfW.gif",
     "s.ytimg.com/yt/img/pixel-vfl3z5WfW.gif"),
    ("http://s.ytimg.com/yt/img/no_thumbnail-vfl4t3-4R.jpg",
     "s.ytimg.com/yt/img/no_thumbnail-vfl4t3-4R.jpg"),
    ("http://s.ytimg.com/yt/img/no_videos_140-vfl5AhOQY.png",
     "s.ytimg.com/yt/img/no_videos_140-vfl5AhOQY.png"),
    ("http://fonts.googleapis.com/css?family=Droid+Sans+TV:regular,bold",
     "fonts.googleapis.com/droid-sans-tv.css"),
]

log = []


def logline(s):
    log.append(s)
    print(s, flush=True)


def sh(cmd):
    return subprocess.call(cmd, shell=True)


def commit_push(msg):
    sh("git add -f %s" % OUT)
    if sh('git commit -q -m "%s"' % msg) == 0:
        sh("git pull -q --rebase origin $GITHUB_REF_NAME 2>/dev/null")
        sh("git push -q origin HEAD:$GITHUB_REF_NAME")


def fetch_raw(full_url, tries=6):
    last = "?"
    for attempt in range(tries):
        if time.time() > DEADLINE:
            return None, "deadline"
        req = urllib.request.Request(full_url, headers={
            "User-Agent": UA,
            "Accept-Encoding": "gzip",
            "Connection": "close",
        })
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                data = r.read()
                if r.headers.get("Content-Encoding") == "gzip" or \
                   data[:2] == b"\x1f\x8b":
                    try:
                        data = gzip.GzipFile(fileobj=io.BytesIO(data)).read()
                    except Exception:
                        pass
                return data, "200"
        except urllib.error.HTTPError as e:
            last = str(e.code)
            if e.code == 404:
                return None, last
            time.sleep(min(90, 15 * (attempt + 1)))
        except Exception as e:
            last = repr(e)
            time.sleep(min(90, 15 * (attempt + 1)))
    return None, last


def fetch(url):
    for ts in (TS, "20120601", "20120801", "2012"):
        if time.time() > DEADLINE:
            return None
        data, status = fetch_raw("https://web.archive.org/web/%sid_/%s"
                                 % (ts, url))
        if data is not None:
            return data
        logline("  try ts=%s -> %s" % (ts, status))
        if status == "deadline":
            return None
    return None


def extract_refs(url, save_path, data):
    """find more assets referenced by downloaded css"""
    refs = []
    if not save_path.endswith(".css"):
        return refs
    try:
        text = data.decode("utf-8", "replace")
    except Exception:
        return refs
    for m in re.findall(r"""url\(\s*['"]?([^'")]+)['"]?\s*\)""", text):
        m = m.strip()
        if m.startswith("data:"):
            continue
        full = urllib.parse.urljoin(url, m)
        m2 = re.search(
            r"web\.archive\.org/web/\d+(?:id_|im_|js_|cs_)?/(https?://.+)",
            full)
        if m2:
            full = m2.group(1)
        full = full.split("#")[0].split("?")[0]
        p = urllib.parse.urlparse(full)
        if p.scheme not in ("http", "https"):
            continue
        host = p.netloc.lower()
        if not any(h in host for h in
                   ("ytimg.com", "gstatic.com", "googleusercontent.com",
                    "googleapis.com", "youtube.com")):
            continue
        refs.append((full, p.netloc + p.path))
    return refs


def main():
    os.makedirs(OUT, exist_ok=True)
    queue = list(SEEDS)
    seen = set(u for u, _ in queue)
    failed = []
    passes = 0

    while queue and passes < 4 and time.time() < DEADLINE:
        passes += 1
        next_failed = []
        while queue:
            if time.time() > DEADLINE:
                logline("deadline reached")
                break
            url, rel = queue.pop(0)
            sp = os.path.join(OUT, rel)
            if os.path.exists(sp) and os.path.getsize(sp) > 0:
                logline("SKIP %s (exists)" % rel)
                data = open(sp, "rb").read()
            else:
                time.sleep(2)
                data = fetch(url)
                if data is None:
                    logline("MISS %s" % url)
                    next_failed.append((url, rel))
                    continue
                os.makedirs(os.path.dirname(sp), exist_ok=True)
                with open(sp, "wb") as f:
                    f.write(data)
                logline("OK   %s (%d bytes)" % (url, len(data)))
                commit_push("wb asset: %s" % rel)
            for ref in extract_refs(url, sp, data):
                if ref[0] not in seen:
                    seen.add(ref[0])
                    queue.append(ref)
        queue = next_failed
        if queue:
            logline("pass %d done, %d failed, retrying" % (passes, len(queue)))
            time.sleep(60)

    with open(os.path.join(OUT, "FETCH_LOG.txt"), "w") as f:
        f.write("\n".join(log) + "\n")
    commit_push("wb fetch log")
    logline("all done")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        logline("EXC: " + traceback.format_exc())
        try:
            with open(os.path.join(OUT, "FETCH_LOG.txt"), "w") as f:
                f.write("\n".join(log) + "\n")
            commit_push("wb fetch log (exc)")
        except Exception:
            pass
    sys.exit(0)
