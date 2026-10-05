/*
=======
yt2009recoverytest.js

a small diagnostics + test page for the deleted / age restricted video
handling. served at /recovery_test.

it tells you:
    - which recovery tools are installed and usable right now
    - every offline fixture that's loaded, what it tests and a link to it
    - a box to classify any video id live, without rendering a page

yt2009, 2022-2033
=======
*/

const unavailable = require("./yt2009unavailable")
const recovery = require("./yt2009recovery")
const fixtures = require("./yt2009fixtures")
const yt2009html = require("./yt2009html")

let config = {}
try { config = require("./config.json") }
catch(error) {}

function esc(s) {
    return unavailable.escapeHtml(s)
}

function toolRows() {
    let status = recovery.toolStatus()
    let rows = ""
    for(let name in status) {
        let t = status[name]
        let ok = t.available === true;
        let detail = []
        if(t.version) detail.push("v" + t.version)
        if(t.path && t.path !== name) detail.push(t.path)
        if(t.clients) detail.push(t.clients.join(", "))
        if(t.ids && t.ids.length) detail.push(t.ids.length + " fixtures")
        rows += `<tr>
            <td class="tool-name">${esc(name)}</td>
            <td class="tool-state ${ok ? "ok" : "no"}">
                ${ok ? "available" : "not available"}
            </td>
            <td class="tool-detail">${esc(detail.join(" &middot; "))}</td>
            <td class="tool-purpose">${esc(t.purpose || "")}</td>
        </tr>`
    }
    return rows;
}

function fixtureRows() {
    let list = fixtures.list()
    if(!list.length) {
        return `<tr><td colspan="4" class="empty">
            offline fixtures are disabled. set
            <code>"offline_fixtures": true</code> in back/config.json
            (or run with <code>YT2009_FIXTURES=1</code>) and restart.
        </td></tr>`
    }
    let rows = ""
    list.forEach(f => {
        let badges = []
        if(f.hasRecoveredPlayer) badges.push("recovers streams")
        if(f.hasRecoveredMetadata) badges.push("recovers metadata")
        if(!badges.length) badges.push("nothing recoverable")
        rows += `<tr>
            <td><a href="/watch?v=${esc(f.id)}"><code>${esc(f.id)}</code></a></td>
            <td><strong>${esc(f.label)}</strong><br>
                <span class="small">${esc(f.describes)}</span></td>
            <td class="small">${esc(f.expect)}</td>
            <td class="small">${esc(badges.join(", "))}<br>
                <a href="/watch?v=${esc(f.id)}">open watchpage &rarr;</a>
                &middot;
                <a href="/recovery_test/classify?v=${esc(f.id)}">classify</a>
            </td>
        </tr>`
    })
    return rows;
}

const PAGE_STYLE = `
body { font-family: Arial, Helvetica, sans-serif; font-size: 13px;
       background: #fff; color: #333; margin: 0; padding: 0; }
.wrap { width: 960px; margin: 0 auto; padding: 18px 0 60px 0; }
h1 { font-size: 20px; margin: 0 0 2px 0; }
h2 { font-size: 15px; margin: 26px 0 8px 0;
     border-bottom: 1px solid #ddd; padding-bottom: 4px; }
p.lede { color: #666; margin: 0 0 6px 0; }
table { border-collapse: collapse; width: 100%; }
th { text-align: left; font-size: 11px; text-transform: uppercase;
     color: #888; padding: 4px 6px; border-bottom: 1px solid #ddd; }
td { padding: 7px 6px; border-bottom: 1px solid #eee;
     vertical-align: top; }
.small { color: #777; font-size: 11px; line-height: 15px; }
.tool-state.ok { color: #0a0; font-weight: bold; }
.tool-state.no { color: #b00; }
.tool-name { font-weight: bold; width: 190px; }
.tool-detail { width: 220px; color: #777; font-size: 11px; }
code { background: #f3f3f3; padding: 1px 4px; font-size: 12px; }
.empty { color: #888; }
form { margin: 8px 0; }
input[type=text] { width: 280px; padding: 4px; font-size: 13px; }
input[type=submit] { padding: 4px 10px; font-size: 13px; }
pre { background: #f7f7f7; border: 1px solid #e3e3e3; padding: 10px;
      font-size: 11px; overflow: auto; }
.banner { background: #fdf6d8; border: 1px solid #e5c74c;
          padding: 8px 10px; margin: 10px 0; }
a { color: #06c; }
`

function page(req, res) {
    let offline = fixtures.isOfflineOnly()
    let banner = ""
    if(fixtures.enabled()) {
        banner = `<div class="banner">
            <strong>offline fixtures are ON.</strong>
            fixture ids below are served from canned innertube responses
            instead of youtube${offline
                ? `, and network recovery is disabled entirely`
                : ``}.
            every other video id behaves normally.
        </div>`
    }

    let html = `<!DOCTYPE html>
<html><head>
<title>yt2009 - unavailable video recovery</title>
<style>${PAGE_STYLE}</style>
</head><body><div class="wrap">
<h1>unavailable video recovery</h1>
<p class="lede">
deleted, age restricted, private, region blocked and members-only videos,
and what yt2009 can still dig up about them.
</p>
${banner}

<h2>recovery tools</h2>
<table>
<tr><th>tool</th><th>state</th><th>detail</th><th>used for</th></tr>
${toolRows()}
</table>

<h2>test cases</h2>
<table>
<tr><th>id</th><th>case</th><th>expected</th><th>recovery</th></tr>
${fixtureRows()}
</table>

<h2>classify any video</h2>
<p class="lede">
fetches a video id through the normal pipeline and reports what state it
classified as, without rendering a watchpage.
</p>
<form action="/recovery_test/classify" method="get">
<input type="text" name="v" placeholder="video id or youtube url">
<input type="submit" value="classify">
</form>

<h2>configuration</h2>
<table>
<tr><th>key</th><th>current</th><th>what it does</th></tr>
<tr><td><code>unavailable_watchpage</code></td>
    <td>${config.unavailable_watchpage === false ? "false" : "true (default)"}</td>
    <td>render a watchpage for unavailable videos instead of redirecting
        to the homepage</td></tr>
<tr><td><code>disable_restricted_recovery</code></td>
    <td>${config.disable_restricted_recovery ? "true" : "false (default)"}</td>
    <td>skip trying alternative player clients on age gated videos</td></tr>
<tr><td><code>recovery_disable_ytdlp</code></td>
    <td>${config.recovery_disable_ytdlp ? "true" : "false (default)"}</td>
    <td>don't shell out to yt-dlp</td></tr>
<tr><td><code>recovery_disable_wayback</code></td>
    <td>${config.recovery_disable_wayback ? "true" : "false (default)"}</td>
    <td>don't query the wayback machine for leftover metadata</td></tr>
<tr><td><code>filmot_key</code></td>
    <td>${config.filmot_key ? "set" : "not set"}</td>
    <td>api key for filmot's deleted-video index</td></tr>
<tr><td><code>ytdlp_path</code></td>
    <td>${esc(config.ytdlp_path || "yt-dlp (PATH)")}</td>
    <td>where to find the yt-dlp binary</td></tr>
<tr><td><code>ytdlp_cookies</code></td>
    <td>${config.ytdlp_cookies ? "set" : "not set"}</td>
    <td>cookies.txt handed to yt-dlp - lets it through age gates that
        need a real account</td></tr>
<tr><td><code>offline_fixtures</code></td>
    <td>${fixtures.enabled() ? "true" : "false (default)"}</td>
    <td>serve the test cases above instead of hitting youtube</td></tr>
<tr><td><code>offline_fixtures_only</code></td>
    <td>${offline ? "true" : "false (default)"}</td>
    <td>never touch the network at all</td></tr>
</table>
</div></body></html>`

    res.set("content-type", "text/html; charset=utf-8")
    res.send(html)
}

function classify(req, res) {
    let id = (req.query.v || "").toString()
    if(id.includes("v=")) id = id.split("v=")[1]
    if(id.includes("youtu.be/")) id = id.split("youtu.be/")[1]
    id = id.split("&")[0].split("?")[0].split("/")[0]
    id = id.replace(/[^a-zA-Z0-9\-_]/g, "").substring(0, 11)

    if(!id) {
        res.redirect("/recovery_test")
        return;
    }

    let started = Date.now()
    yt2009html.innertube_get_data(id, (response) => {
        let c = unavailable.classify(response)
        let report = {
            "id": id,
            "tookMs": Date.now() - started,
            "classification": c,
            "playabilityStatus": (response || {}).playabilityStatus || null,
            "hasVideoDetails": !!((response || {}).videoDetails),
            "recoverySource": (response || {}).yt2009RecoverySource || null,
            "wasRestricted": !!((response || {}).yt2009WasRestricted),
            "fromFixture": !!((response || {}).isFixture)
        }
        if(req.query.format == "json") {
            res.set("content-type", "application/json")
            res.send(JSON.stringify(report, null, 4))
            return;
        }
        let html = `<!DOCTYPE html>
<html><head><title>yt2009 - classify ${esc(id)}</title>
<style>${PAGE_STYLE}</style></head><body><div class="wrap">
<h1>classify: <code>${esc(id)}</code></h1>
<p class="lede">
<a href="/recovery_test">&larr; back</a> &middot;
<a href="/watch?v=${esc(id)}">open the watchpage</a> &middot;
<a href="/recovery_test/classify?v=${esc(id)}&amp;format=json">json</a>
</p>
<h2>verdict</h2>
<table>
<tr><th>field</th><th>value</th></tr>
<tr><td>state</td><td><strong>${esc(c.state)}</strong></td></tr>
<tr><td>playable</td><td>${c.ok ? "yes" : "no"}</td></tr>
<tr><td>innertube status</td><td><code>${esc(c.status)}</code></td></tr>
<tr><td>reason</td><td>${esc(c.reason) || "<span class=small>-</span>"}</td></tr>
<tr><td>subreason</td><td>${esc(c.subreason) || "<span class=small>-</span>"}</td></tr>
<tr><td>metadata present</td><td>${c.hasMetadata ? "yes" : "no"}</td></tr>
<tr><td>streams present</td><td>${c.hasStreams ? "yes" : "no"}</td></tr>
<tr><td>worth retrying other clients</td>
    <td>${c.recoverable ? "yes" : "no"}</td></tr>
<tr><td>needs metadata dug up</td>
    <td>${c.needsMetadata ? "yes" : "no"}</td></tr>
<tr><td>recovered via</td>
    <td>${esc(report.recoverySource || "-")}</td></tr>
<tr><td>served from fixture</td>
    <td>${report.fromFixture ? "yes" : "no"}</td></tr>
<tr><td>took</td><td>${report.tookMs} ms</td></tr>
</table>
<h2>what the page would say</h2>
<table>
<tr><td>headline</td><td>${esc(c.headline) || "-"}</td></tr>
<tr><td>player box</td><td>${esc(c.playerMessage) || "-"}</td></tr>
<tr><td>detail</td><td>${esc(c.body) || "-"}</td></tr>
</table>
<h2>raw playabilityStatus</h2>
<pre>${esc(JSON.stringify(report.playabilityStatus, null, 2))}</pre>
</div></body></html>`
        res.set("content-type", "text/html; charset=utf-8")
        res.send(html)
    })
}

module.exports = {
    "page": page,
    "classify": classify
}
