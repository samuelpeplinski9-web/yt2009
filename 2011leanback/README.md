# 2011leanback

The 2011/2012 HTML5 YouTube **Leanback** ("YouTube on TV") interface,
restored from the Wayback Machine and wired into this yt2009 instance.

Open it at: **`/2011leanback`** (e.g. `http://yourinstance:port/2011leanback#menu/LNroot,3,FEfeatured`)

## Provenance

| file | source |
|---|---|
| `index.html` | Wayback Machine capture `20120622093607` of `http://www.youtube.com/leanback` (raw `id_` flavor), URL-patched |
| `stylesheet/tv-html5.css` | Wayback capture of `www.gstatic.com/youtube/leanback/3f68892c/stylesheet/tv-html5.css`, URL-patched |
| `javascript/tv-html5.js` | gstatic build `3f68892c` (byte-identical mirror via kawe-ui/OldPipe-2012, verified against the Wayback capture), URL-patched |
| `javascript/html5player.js`, `stylesheet/www-player.css` | period `html5player`/`www-player` builds (OldPipe-2012 mirror of s.ytimg.com assets) |
| `swfbin/*.swf` | 2012-era `watch_as3` flash visual player + leanback player SWFs (s.ytimg.com swfbin mirrors) |
| `img/`, `imgbin/` | s.ytimg.com `yt/img` + `yt/imgbin` sprites referenced by the stylesheets |
| `fonts/` | Droid Sans TV (self-hosted; originally `fonts.googleapis.com`) |
| `html5_player_template.html` | `/html5_player_template` fragment referenced by the page's `swf_config` |

Raw unpatched captures are kept in `../2011leanback_raw/` —
`.wb/build_2011leanback.py` rebuilds this folder from them (it prefers
authentic Wayback files and falls back to the GitHub mirrors), so if more
raw captures are added (e.g. the exact `watch_as3-vflTL1Rpm.swf` /
`cps-vflDeURDJ.swf` / `html5player-vflBfju3R.js`) just re-run the script.

## What got rewired to the yt2009 instance

All of this is handled by `back/backend.js` (section "2011/2012 html5
leanback") plus the URL patches inside the files here:

* `http(s)://gdata.youtube.com/feeds/api/...` → same-origin `/feeds/api/...`
  — the instance's YouTube GData API pipeline (`yt2009cps`,
  `yt2009jsongdata`, `yt2009mobile`). `alt=json-in-script` + JSONP
  `callback=` requests are adapted by a compat middleware.
* search → `/search_ajax?style=json&search_query=...` resolved through
  `yt2009search` (same pipeline as the rest of the instance).
* playback → `/get_video_info?video_id=..&html5=1&el=leanback` returns a
  proper `url_encoded_fmt_stream_map` (plus `rvs` related videos) using the
  instance's own `/exp_hd`, `/get_480` and `/get_video` endpoints, with
  relative URLs so it works behind any hostname/proxy.
* suggestions → `/complete/search` (yt2009's suggest endpoint).
* `/feeds/api/videos/batch`, `/leanback_ajax?action_user_info` /
  `action_user_playlists`, `/leanback_oauth`, `/api/lounge/data/iframe`,
  `/html5_player_template` → served/stubbed by the backend so the TV UI
  boots cleanly while signed out.
