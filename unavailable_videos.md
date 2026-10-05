# deleted & restricted videos

before this, any video youtube refused to hand over was a dead end. `/watch?v=` bounced
straight back to the homepage (losing the video id entirely), and `/embed/` rendered a
player that could never load anything. that covered a lot of ground: deleted videos,
terminated accounts, copyright strikes, age gates, region blocks, members-only videos,
private videos — and plain network failures, which looked identical to deletion.

now every one of those renders a real 2009 watchpage, with whatever title, uploader,
description, view count, comments and related videos can still be found, and a player
area that says what actually happened.

age restricted videos go one step further: yt2009 tries to recover the real streams
first, and if it succeeds the video just plays.

---

## trying it out

`/recovery_test` is a diagnostics page listing:

- which recovery tools are installed and their versions
- every bundled test video, with links to its watchpage and its raw classification
- a box to paste any video id or url and see exactly how yt2009 classifies it
- the relevant config values currently in effect

`/recovery_test/classify?v=<id>` returns the same classification as html, or as json
with `&format=json`.

### bundled test videos

`back/fixtures/` holds canned innertube responses for every failure mode, so the whole
feature can be exercised without hunting down a real deleted video. turn them on with
`"offline_fixtures": true` in `back/config.json` and open any of:

| id | what it is |
| --- | --- |
| `t3stDELmeta` | deleted, metadata recovered from an archived gdata response |
| `t3stDELterm` | uploader's account terminated, recovered from an archived watchpage (with comments) |
| `t3stDELnone` | deleted, nothing recoverable anywhere |
| `t3stAGEokay` | age restricted, **streams successfully recovered** — this one plays |
| `t3stAGEgate` | age restricted, recovery failed, metadata intact |
| `t3stPRIVate` | private video (which youtube reports the same way as an age gate) |
| `t3stCOPYrgt` | removed over a copyright claim |
| `t3stGEOblok` | blocked in this region |
| `t3stTOSrm0v` | removed for a terms of service violation |
| `t3stMEMonly` | members only |
| `t3stUSRdel0` | removed by the uploader |
| `t3stNETfail` | youtube unreachable — must *not* read as "deleted" |

`"offline_fixtures_only": true` additionally stops yt2009 from touching the network at
all, which is useful when developing somewhere youtube isn't reachable. leave it off
otherwise — with just `offline_fixtures` on, real video ids still work normally and only
the twelve `t3st*` ids come from disk.

---

## how it works

### 1. classification — `back/yt2009unavailable.js`

`classify(playerResponse)` turns an innertube response into a verdict:

```js
{
    state: "age_restricted",          // deleted, private, copyright_claim, ...
    ok: false,
    status: "LOGIN_REQUIRED",
    reason: "Sign in to confirm your age",
    subreason: "This video may be inappropriate for some users.",
    headline: "...",                  // 2009-era copy for the notice bar
    body: "...",                      // 2009-era copy for the player area
    playerMessage: "...",
    hasMetadata: true,                // videoDetails survived
    hasStreams: false,
    recoverable: true,                // worth retrying with another client
    inlineMetadata: { ... }           // scraped off the failing response
}
```

this is string matching on `playabilityStatus`, not just a status check, because youtube
reuses statuses across completely different situations — a private video and an age gated
video are both `LOGIN_REQUIRED`, and members-only, region blocked and paywalled videos are
all `UNPLAYABLE`. getting those confused produces wrong, confusing copy, so each is matched
on its reason/subreason text.

it also matters that this runs *before* yt2009 tries to read `videoDetails.title`. age
gates, region blocks and members-only responses carry a complete `videoDetails` block, so
the old "did reading the title throw?" check waved them through as if they were fine, and
the watchpage then hung waiting on comments that were never coming.

### 2. recovery — `back/yt2009recovery.js`

**streams** (for anything `recoverable`), in order, first hit wins:

1. four raw innertube embed clients — `TVHTML5_SIMPLY_EMBEDDED_PLAYER`, `WEB_EMBEDDED_PLAYER`,
   `MWEB`, `IOS`. no dependencies, and between them they clear most age gates.
2. [youtubei.js](https://github.com/LuanRT/YouTube.js), if installed
3. [yt-dlp](https://github.com/yt-dlp/yt-dlp), if installed — the heaviest option, and the
   only one that can use your cookies for videos that genuinely need a login

**metadata** (for anything already lost), in order, best wins:

1. yt2009's own local video cache — if you watched it before it went, it's still here
2. yt-dlp
3. the wayback machine's copy of the old gdata api
4. the wayback machine's copy of youtube's oembed endpoint
5. the wayback machine's copy of the watchpage itself — slowest, but this is the one that
   can bring back the description, comments and related videos
6. [filmot](https://filmot.com), with `filmot_key` set

results are cached in `back/cache_dir/recovery_cache.json` for two weeks, so a deleted video
costs one slow page load and is instant after that.

### 3. rendering

the page is built exactly as normal and then post-processed, rather than having
`if(unavailable)` scattered through the ~5000 lines of `applyWatchpageHtml`. the player area
is swapped for an overlay (using the video's thumbnail as a backdrop when one survives),
the player bootstrap javascript is neutralised, a notice bar is added above the player, and
download/favourite/share actions are hidden.

recovered videos get a notice bar too, saying which client the stream came from, so a
working age gate bypass is visible rather than silent.

none of these pages return a 4xx — internet explorer 6 throws away short 4xx bodies and
substitutes its own error page, which would defeat the whole point. they're all 200.

---

## installing the recovery tools

neither is required. with no tools installed you still get the embed-client stream recovery
and the wayback metadata lookups, which cover most cases.

**yt-dlp** (recommended):

```sh
python3 -m pip install -U yt-dlp
# or: sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp
```

if it isn't on your `PATH`, point `ytdlp_path` at it.

**youtubei.js**:

```sh
npm install youtubei.js
```

for age restricted videos that none of the anonymous clients can get at, give yt-dlp a
logged-in session:

```json
{
    "ytdlp_cookies": "/path/to/cookies.txt"
}
```

or `"ytdlp_cookies_from_browser": "firefox"` to read them straight out of a browser profile.
use a throwaway account — youtube does ban for this.

check what was picked up at `/recovery_test`.
