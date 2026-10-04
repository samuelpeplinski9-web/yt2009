#!/usr/bin/env python3
# Builds the 2011leanback/ folder from archived sources:
#  - 2011leanback_raw/   (raw Wayback Machine captures, preferred)
#  - /tmp/oldpipe/       (kawe-ui/OldPipe-2012 mirror of the same build)
#  - /tmp/cmdhue/        (cmd-hue 2011leanback mirror - fonts)
# Rewrites asset URLs to /2011leanback/... and API hosts to same-origin
# so feeds/search/playback resolve through this yt2009 instance.
import os
import shutil
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "2011leanback_raw")
OUT = os.path.join(ROOT, "2011leanback")
OLDPIPE = "/tmp/oldpipe"
CMDHUE = "/tmp/cmdhue"


def pick(*cands):
    for c in cands:
        if c and os.path.exists(c):
            return c
    return None


def put(src, rel):
    dst = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)
    print("copy %s -> %s" % (src, rel))
    return dst


def main():
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    # ---------- core app files ----------
    html_src = pick(os.path.join(RAW, "www.youtube.com/leanback.html"))
    css_src = pick(
        os.path.join(RAW, "www.gstatic.com/youtube/leanback/3f68892c/stylesheet/tv-html5.css"),
        os.path.join(OLDPIPE, "youtube/leanback/3f68892c/stylesheet/tv-html5.css"))
    js_src = pick(
        os.path.join(RAW, "www.gstatic.com/youtube/leanback/3f68892c/javascript/tv-html5.js"),
        os.path.join(OLDPIPE, "youtube/leanback/3f68892c/javascript/tv-html5.js"))
    assert html_src and css_src and js_src, "missing core assets"

    # ---------- stylesheet ----------
    css = open(css_src, encoding="utf-8", errors="replace").read()
    css = css.replace("url(/img/", "url(/2011leanback/img/")
    css = css.replace("url(/imgbin/", "url(/2011leanback/imgbin/")
    os.makedirs(os.path.join(OUT, "stylesheet"))
    open(os.path.join(OUT, "stylesheet/tv-html5.css"), "w",
         encoding="utf-8").write(css)
    print("built stylesheet/tv-html5.css")

    # www-player.css (flash/jsapi player skin referenced by swf_config)
    wp = pick(
        os.path.join(RAW, "s.ytimg.com/yt/cssbin/www-player-vfltUaqw8.css"),
        os.path.join(OLDPIPE, "yts/cssbin/www-player-vflAP1Pz1.css"))
    if wp:
        t = open(wp, encoding="utf-8", errors="replace").read()
        t = t.replace("url(/img/", "url(/2011leanback/img/")
        t = t.replace("url(/imgbin/", "url(/2011leanback/imgbin/")
        t = t.replace("//s.ytimg.com/yt/imgbin/", "/2011leanback/imgbin/")
        t = t.replace("//s.ytimg.com/yt/img/", "/2011leanback/img/")
        open(os.path.join(OUT, "stylesheet/www-player.css"), "w",
             encoding="utf-8").write(t)
        print("built stylesheet/www-player.css")

    # ---------- javascript ----------
    js = open(js_src, encoding="utf-8", errors="replace").read()
    # gdata API -> same origin (yt2009 /feeds/api pipeline)
    js = js.replace("https://gdata.youtube.com", "")
    js = js.replace("http://stage.gdata.youtube.com", "")
    js = js.replace("http://gdata.youtube.com", "")
    # default thumbnail -> local copy
    js = js.replace("http://s.ytimg.com/yt/img/no_thumbnail-vflJ2qsDs.jpg",
                    "/2011leanback/img/no_thumbnail.jpg")
    # oldpipe patched oauth origin; point it at our own origin instead
    js = js.replace('"http://localhost:5000"', "window.location.origin")
    js = js.replace('"https://www.youtube.com/leanback_oauth"',
                    '"/leanback_oauth"')
    # search suggestions -> yt2009 /complete/search
    js = js.replace("//suggestqueries.google.com/complete/search",
                    "/complete/search")
    os.makedirs(os.path.join(OUT, "javascript"))
    open(os.path.join(OUT, "javascript/tv-html5.js"), "w",
         encoding="utf-8").write(js)
    print("built javascript/tv-html5.js")

    # html5player module (used by the jsapi/flash-fallback player config)
    hp = pick(
        os.path.join(RAW, "s.ytimg.com/yt/jsbin/html5player-vflBfju3R.js"),
        os.path.join(OLDPIPE, "yts/jsbin/html5player-vflZifxKH.js"))
    if hp:
        t = open(hp, encoding="utf-8", errors="replace").read()
        t = t.replace("https://gdata.youtube.com", "")
        t = t.replace("http://gdata.youtube.com", "")
        open(os.path.join(OUT, "javascript/html5player.js"), "w",
             encoding="utf-8").write(t)
        print("built javascript/html5player.js")

    # ---------- fonts (Droid Sans TV, self-hosted) ----------
    os.makedirs(os.path.join(OUT, "fonts"))
    reg = pick(os.path.join(CMDHUE, "2011leanback/4OOoR_zjNP4T-zdQ8Yh_5UDSgbE7mQYsZh5sxQr8MH4.ttf"))
    bold = pick(os.path.join(CMDHUE, "2011leanback/Jbq3YPwzagUGcF8OGkpJLSXcl4nSJdsn8QOlJHNtLzU.ttf"))
    if reg:
        put(reg, "fonts/DroidSansTV.ttf")
    if bold:
        put(bold, "fonts/DroidSansTV-Bold.ttf")
    open(os.path.join(OUT, "fonts/droidsanstv.css"), "w").write(
"""@font-face {
  font-family: 'Droid Sans TV';
  font-style: normal;
  font-weight: normal;
  src: url(/2011leanback/fonts/DroidSansTV.ttf) format('truetype');
}
@font-face {
  font-family: 'Droid Sans TV';
  font-style: normal;
  font-weight: bold;
  src: url(/2011leanback/fonts/DroidSansTV-Bold.ttf) format('truetype');
}
""")
    print("built fonts/")

    # ---------- images ----------
    imgs = [
        # (candidates..., out rel)
        ((os.path.join(RAW, "s.ytimg.com/yt/img/pixel-vfl3z5WfW.gif"),
          os.path.join(OLDPIPE, "yts/img/pixel-vfl3z5WfW.gif")),
         "img/pixel-vfl3z5WfW.gif"),
        ((os.path.join(RAW, "s.ytimg.com/yt/img/no_thumbnail-vfl4t3-4R.jpg"),
          os.path.join(OLDPIPE, "yts/img/no_thumbnail-vfl4t3-4R.jpg")),
         "img/no_thumbnail.jpg"),
        ((os.path.join(RAW, "s.ytimg.com/yt/img/no_videos_140-vfl5AhOQY.png"),
          os.path.join(OLDPIPE, "yts/img/no_videos_140-vfl5AhOQY.png")),
         "img/no_videos_140.png"),
        ((os.path.join(OLDPIPE, "yts/img/html5_play_button-vflpHsbZb.png"),),
         "img/html5_play_button.png"),
        ((os.path.join(OLDPIPE, "yts/img/loader-vflff1Mjj.gif"),),
         "img/loader.gif"),
    ]
    for cands, rel in imgs:
        s = pick(*cands)
        if s:
            put(s, rel)

    sprites = [
        ("player-common", ("player-common-vflXVjbFd.png",
                           "player-common-vflGpPVmw.png")),
        ("player-dark", ("player-dark-vflCDBE54.png",
                         "player-dark-vfllzTuHQ.png")),
        ("player-light", ("player-light-vflm__o3E.png",
                          "player-light-vfllunIzZ.png")),
        ("player-tablet", ("player-tablet-vflKC6exR.png",
                           "player-tablet-vflCWI25O.png")),
        ("www-refresh", ("www-refresh-vflMLqC23.png",
                         "www-refresh-vflIJtcPd.png")),
        ("www-sharing", ("www-sharing-vflIBlxAE.png",
                         "www-sharing-vfl6YoIO_.png")),
    ]
    for name, cands in sprites:
        s = pick(*[os.path.join(OLDPIPE, "yts/imgbin", c) for c in cands])
        if s:
            put(s, "imgbin/%s.png" % name)

    # ---------- swf players ----------
    swfs = [
        ((os.path.join(RAW, "s.ytimg.com/yt/swfbin/watch_as3-vflTL1Rpm.swf"),
          os.path.join(OLDPIPE, "yts/swfbin/watch_as3-vfldzrQK1.swf")),
         "swfbin/watch_as3-vflTL1Rpm.swf"),
        ((os.path.join(RAW, "s.ytimg.com/yt/swfbin/cps-vflDeURDJ.swf"),
          os.path.join(OLDPIPE, "yts/swfbin/2012lplayer_localhost_patched.swf")),
         "swfbin/cps-vflDeURDJ.swf"),
    ]
    for cands, rel in swfs:
        s = pick(*cands)
        if s:
            put(s, rel)

    # html5 player template fragment (served at /html5_player_template)
    tpl = pick(os.path.join(OLDPIPE, "html5_player_template"))
    if tpl:
        put(tpl, "html5_player_template.html")

    # ---------- index.html ----------
    html = open(html_src, encoding="utf-8", errors="replace").read()

    def both(s, a, b):
        """replace plain + json-escaped variants"""
        s = s.replace(a, b)
        s = s.replace(a.replace("/", "\\/"), b.replace("/", "\\/"))
        return s

    html = html.replace(
        '//fonts.googleapis.com/css?family=Droid+Sans+TV:regular,bold',
        '/2011leanback/fonts/droidsanstv.css')
    html = html.replace(
        '//www.gstatic.com/youtube/leanback/3f68892c/stylesheet/tv-html5.css',
        '/2011leanback/stylesheet/tv-html5.css')
    html = html.replace(
        '//www.gstatic.com/youtube/leanback/3f68892c/javascript/tv-html5.js',
        '/2011leanback/javascript/tv-html5.js')
    html = html.replace('//s.ytimg.com/yt/img/pixel-vfl3z5WfW.gif',
                        '/2011leanback/img/pixel-vfl3z5WfW.gif')
    html = html.replace(
        'https://www.youtube.com/api/lounge/data/iframe?allowFrom=http',
        '/api/lounge/data/iframe')
    html = html.replace(
        'https://www.youtube.com/leanback_oauth?allowFrom=http',
        '/leanback_oauth')
    # gdata feeds -> same-origin yt2009 /feeds/api pipeline
    html = both(html, "http://gdata.youtube.com", "")
    html = both(html, "https://gdata.youtube.com", "")
    # player assets -> local
    html = both(html, "http://s.ytimg.com/yt/swfbin/watch_as3-vflTL1Rpm.swf",
                "/2011leanback/swfbin/watch_as3-vflTL1Rpm.swf")
    html = both(html, "http://s.ytimg.com/yt/swfbin/cps-vflDeURDJ.swf",
                "/2011leanback/swfbin/cps-vflDeURDJ.swf")
    html = both(html, "http://s.ytimg.com/yt/cssbin/www-player-vfltUaqw8.css",
                "/2011leanback/stylesheet/www-player.css")
    html = both(html, "http://s.ytimg.com/yt/jsbin/html5player-vflBfju3R.js",
                "/2011leanback/javascript/html5player.js")
    html = both(html, "http://s.ytimg.com/yt/img/no_thumbnail-vfl4t3-4R.jpg",
                "/2011leanback/img/no_thumbnail.jpg")
    html = both(html, "//s.ytimg.com/yt/img/no_videos_140-vfl5AhOQY.png",
                "/2011leanback/img/no_videos_140.png")

    open(os.path.join(OUT, "index.html"), "w", encoding="utf-8").write(html)
    print("built index.html")

    # leftover absolute hosts report
    left = sorted(set(re.findall(
        r'(?:https?:)?(?:\\/\\/|//)[a-z0-9.-]+\.(?:com|net|org)[^"\'\s\\<>]*',
        html)))
    print("\nremaining external refs in index.html:")
    for x in left:
        print("  ", x.replace("\\/", "/")[:120])


if __name__ == "__main__":
    main()
