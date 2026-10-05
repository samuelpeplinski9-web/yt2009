/*
=======
yt2009unavailable.js

handles videos youtube will not hand us a normal player response for:
    - deleted / removed videos (incl. ones that still have metadata somewhere)
    - age restricted ("sign in to confirm your age") videos
    - private, members only, region blocked, terminated accounts, copyright
      claims, tos removals, ended livestreams

this module is purely about *classifying* a broken playabilityStatus and
turning it into something the 2009 watchpage can actually render.
the actual digging for leftover metadata/streams lives in yt2009recovery.js.

yt2009, 2022-2033
=======
*/

const fs = require("fs")

/*
=======
states
=======
*/
const STATES = {
    "OK": "ok",
    "AGE_RESTRICTED": "age_restricted",
    "DELETED": "deleted",
    "REMOVED_BY_USER": "removed_by_user",
    "ACCOUNT_TERMINATED": "account_terminated",
    "COPYRIGHT": "copyright",
    "TOS_VIOLATION": "tos_violation",
    "PRIVATE": "private",
    "MEMBERS_ONLY": "members_only",
    "REGION_BLOCKED": "region_blocked",
    "PAYWALLED": "paywalled",
    "LIVE_ENDED": "live_ended",
    "LIVE_UPCOMING": "live_upcoming",
    "NETWORK_FAILURE": "network_failure",
    "UNAVAILABLE": "unavailable"
}

// states where youtube still happily hands over full metadata +
// (with a different client) even the streams
const AGE_GATE_STATES = [STATES.AGE_RESTRICTED]

// states where the video is gone for good and we have to dig metadata up
const GONE_STATES = [
    STATES.DELETED,
    STATES.REMOVED_BY_USER,
    STATES.ACCOUNT_TERMINATED,
    STATES.COPYRIGHT,
    STATES.TOS_VIOLATION,
    STATES.UNAVAILABLE,
    STATES.NETWORK_FAILURE
]

// states where the video exists, we just can't have it
const BLOCKED_STATES = [
    STATES.PRIVATE,
    STATES.MEMBERS_ONLY,
    STATES.REGION_BLOCKED,
    STATES.PAYWALLED,
    STATES.LIVE_ENDED,
    STATES.LIVE_UPCOMING
]

/*
=======
2009-accurate copy for each state
=======
the strings below are what 2009/2010 youtube actually put on the page.
*/
const STATE_COPY = {
    [STATES.AGE_RESTRICTED]: {
        "headline": "Sign in to confirm your age",
        "body": "This video may be inappropriate for some users.",
        "player": "This video may contain content that is inappropriate for some users."
    },
    [STATES.DELETED]: {
        "headline": "This video is no longer available.",
        "body": "Sorry about that.",
        "player": "This video is no longer available."
    },
    [STATES.REMOVED_BY_USER]: {
        "headline": "This video has been removed by the user.",
        "body": "Sorry about that.",
        "player": "This video has been removed by the user."
    },
    [STATES.ACCOUNT_TERMINATED]: {
        "headline": "This video is no longer available because the YouTube account associated with this video has been terminated.",
        "body": "Sorry about that.",
        "player": "This video is no longer available because the YouTube account associated with this video has been terminated."
    },
    [STATES.COPYRIGHT]: {
        "headline": "This video is no longer available due to a copyright claim.",
        "body": "Sorry about that.",
        "player": "This video is no longer available due to a copyright claim."
    },
    [STATES.TOS_VIOLATION]: {
        "headline": "This video has been removed for violating YouTube's Terms of Service.",
        "body": "Sorry about that.",
        "player": "This video has been removed for violating YouTube's Terms of Service."
    },
    [STATES.PRIVATE]: {
        "headline": "This video is private.",
        "body": "Sorry about that.",
        "player": "This video is private."
    },
    [STATES.MEMBERS_ONLY]: {
        "headline": "This video is available to this channel's members only.",
        "body": "Sorry about that.",
        "player": "This video is available to this channel's members only."
    },
    [STATES.REGION_BLOCKED]: {
        "headline": "This video is not available in your country.",
        "body": "The uploader has not made this video available in your country.",
        "player": "The uploader has not made this video available in your country."
    },
    [STATES.PAYWALLED]: {
        "headline": "This video requires payment to watch.",
        "body": "Sorry about that.",
        "player": "This video requires payment to watch."
    },
    [STATES.LIVE_ENDED]: {
        "headline": "This live stream recording is not available.",
        "body": "Sorry about that.",
        "player": "This live stream recording is not available."
    },
    [STATES.LIVE_UPCOMING]: {
        "headline": "This live event has not started yet.",
        "body": "Come back later.",
        "player": "This live event has not started yet."
    },
    [STATES.NETWORK_FAILURE]: {
        "headline": "This video could not be loaded.",
        "body": "YouTube could not be reached. Try again in a moment.",
        "player": "This video could not be loaded."
    },
    [STATES.UNAVAILABLE]: {
        "headline": "This video is unavailable.",
        "body": "Sorry about that.",
        "player": "This video is unavailable."
    }
}

/*
=======
matching rules
=======
order matters - first match wins.
*/
const RULES = [
    // --- age gate ---
    {
        "state": STATES.AGE_RESTRICTED,
        "match": [
            "sign in to confirm your age",
            "this video may be inappropriate for some users",
            "age-restricted",
            "age restricted",
            "confirm your age",
            "inappropriate for some users"
        ]
    },
    {
        "state": STATES.AGE_RESTRICTED,
        "status": ["AGE_VERIFICATION_REQUIRED", "AGE_CHECK_REQUIRED"]
    },
    // --- private ---
    {
        "state": STATES.PRIVATE,
        "match": [
            "this video is private",
            "private video",
            "sign in if you've been granted access"
        ]
    },
    // --- account terminated ---
    {
        "state": STATES.ACCOUNT_TERMINATED,
        "match": [
            "account associated with this video has been terminated",
            "account has been terminated",
            "this account has been terminated"
        ]
    },
    // --- copyright ---
    {
        "state": STATES.COPYRIGHT,
        "match": [
            "copyright claim",
            "copyright grounds",
            "blocked it on copyright grounds",
            "copyright infringement"
        ]
    },
    // --- tos ---
    {
        "state": STATES.TOS_VIOLATION,
        "match": [
            "violating youtube's terms of service",
            "violating youtube's policy",
            "violating youtube's community guidelines",
            "removed for violating"
        ]
    },
    // --- removed by uploader ---
    {
        "state": STATES.REMOVED_BY_USER,
        "match": [
            "removed by the user",
            "removed by the uploader",
            "deleted by the user",
            "the uploader has removed"
        ]
    },
    // --- members only / paid ---
    {
        "state": STATES.MEMBERS_ONLY,
        "match": [
            "members-only",
            "members only",
            "join this channel to get access"
        ]
    },
    {
        "state": STATES.PAYWALLED,
        "match": [
            "purchase this",
            "rent or buy",
            "requires payment"
        ]
    },
    // --- region ---
    {
        "state": STATES.REGION_BLOCKED,
        "match": [
            "not made this video available in your country",
            "not available in your country",
            "who has blocked it in your country",
            "contains content from",
            "blocked it in your country"
        ]
    },
    // --- live ---
    {
        "state": STATES.LIVE_UPCOMING,
        "match": [
            "live event will begin",
            "premiere will begin",
            "has not started"
        ]
    },
    {
        "state": STATES.LIVE_ENDED,
        "match": [
            "live stream recording is not available",
            "live stream offline"
        ]
    },
    // --- generic gone ---
    {
        "state": STATES.DELETED,
        "match": [
            "no longer available",
            "video unavailable",
            "this video isn't available anymore",
            "video not found",
            "does not exist"
        ]
    },
    {
        "state": STATES.UNAVAILABLE,
        "match": [
            "this video is unavailable",
            "this video is not available",
            "unavailable"
        ]
    }
]

/*
=======
helpers
=======
*/

// innertube text nodes come as either {simpleText} or {runs:[{text}]}
function readText(node) {
    if(!node) return "";
    if(typeof node == "string") return node;
    if(node.simpleText) return node.simpleText;
    if(node.runs && node.runs.length) {
        return node.runs.map(r => {return r.text || ""}).join("")
    }
    if(node.content) return node.content;
    return "";
}

function escapeHtml(s) {
    return (s || "").toString()
        .split("&").join("&amp;")
        .split("<").join("&lt;")
        .split(">").join("&gt;")
        .split('"').join("&quot;")
}

/*
=======
classify
=======
takes a raw innertube player response (or anything resembling one) and
figures out what exactly is wrong with it.

returns:
{
    state,            - one of STATES
    ok,               - true if nothing's wrong
    reason,           - youtube's headline string
    subreason,        - youtube's detail string
    headline,         - 2009-accurate headline for our page
    body,             - 2009-accurate detail for our page
    playerMessage,    - 2009-accurate player overlay message
    hasMetadata,      - does the response still carry videoDetails?
    recoverable,      - is it worth trying alternative clients for streams?
    needsMetadata     - do we have to go dig metadata up elsewhere?
}
*/
function classify(playerResponse) {
    let result = {
        "state": STATES.OK,
        "ok": true,
        "status": "OK",
        "reason": "",
        "subreason": "",
        "headline": "",
        "body": "",
        "playerMessage": "",
        "hasMetadata": false,
        "hasStreams": false,
        "recoverable": false,
        "needsMetadata": false
    }

    if(!playerResponse || typeof playerResponse !== "object") {
        result.state = STATES.NETWORK_FAILURE
        result.ok = false;
        result.status = "NETWORK_FAILURE"
        applyCopy(result)
        result.needsMetadata = true;
        return result;
    }

    const ps = playerResponse.playabilityStatus || {}
    const vd = playerResponse.videoDetails || null;
    result.status = ps.status || (vd ? "OK" : "NO_STATUS")
    result.hasMetadata = !!(vd && vd.title)
    result.hasStreams = !!(
        playerResponse.streamingData
     && (
            (playerResponse.streamingData.formats || []).length
         || (playerResponse.streamingData.adaptiveFormats || []).length
         || playerResponse.streamingData.serverAbrStreamingUrl
        )
    )

    // pull every string youtube gave us about why this failed
    let errorScreen = ps.errorScreen || {}
    let per = errorScreen.playerErrorMessageRenderer
           || errorScreen.playerLegacyDesktopYpcTrailerRenderer
           || errorScreen.ypcTrailerRenderer
           || {}
    let reason = readText(ps.reason) || readText(per.reason)
    let subreason = readText(ps.subreason)
                 || readText(per.subreason)
                 || readText(ps.messages && ps.messages[0])
    // some responses stuff the detail in errorScreen.*.proceedButton etc
    if(!subreason && ps.errorScreen) {
        try {
            let flat = JSON.stringify(ps.errorScreen)
            let m = flat.match(/"simpleText":"([^"]{12,})"/)
            if(m && m[1] && m[1] !== reason) {
                subreason = m[1]
            }
        }
        catch(error) {}
    }
    result.reason = reason;
    result.subreason = subreason;

    // status OK + metadata + streams = nothing to do here
    if((ps.status == "OK" || !ps.status) && result.hasMetadata) {
        if(result.hasStreams || playerResponse.isFixture) {
            return result;
        }
    }

    if(ps.status == "OK" && !result.hasMetadata && !playerResponse.videoDetails) {
        // weird empty OK - treat as a network-ish failure
        result.state = STATES.NETWORK_FAILURE
        result.ok = false;
        applyCopy(result)
        result.needsMetadata = true;
        return result;
    }

    if(ps.status == "OK") {
        return result;
    }

    // explicitly flagged by our own watchdog
    if(ps.yt2009NetworkFailure) {
        result.state = STATES.NETWORK_FAILURE
        result.ok = false;
        applyCopy(result)
        result.needsMetadata = !result.hasMetadata;
        return result;
    }

    // run the rules
    let haystack = [reason, subreason, ps.status, readText(ps.errorScreen
        && ps.errorScreen.playerErrorMessageRenderer
        && ps.errorScreen.playerErrorMessageRenderer.proceedButton)]
        .join(" ").toLowerCase()

    let matched = null;
    for(let rule of RULES) {
        if(rule.status && rule.status.includes(ps.status)) {
            matched = rule.state;
            break;
        }
        if(rule.match) {
            for(let phrase of rule.match) {
                if(haystack.includes(phrase)) {
                    matched = rule.state;
                    break;
                }
            }
        }
        if(matched) break;
    }

    if(!matched) {
        // fall back on the raw status
        switch(ps.status) {
            case "LOGIN_REQUIRED": {
                // LOGIN_REQUIRED is both the age gate AND private videos.
                // without a usable string assume age gate, since private
                // videos basically always say so explicitly.
                matched = STATES.AGE_RESTRICTED
                break;
            }
            case "UNPLAYABLE": {
                matched = result.hasMetadata
                        ? STATES.REGION_BLOCKED
                        : STATES.UNAVAILABLE
                break;
            }
            case "LIVE_STREAM_OFFLINE": {
                matched = STATES.LIVE_UPCOMING
                break;
            }
            case "CONTENT_CHECK_REQUIRED": {
                matched = STATES.AGE_RESTRICTED
                break;
            }
            case "ERROR":
            default: {
                matched = STATES.DELETED
                break;
            }
        }
    }

    result.state = matched;
    result.ok = false;
    applyCopy(result)

    // youtube very often refuses to *play* a video while happily handing
    // over its entire videoDetails block (age gates, region blocks and
    // members-only videos basically always do). grab that before we go
    // off digging through archives for something we already have.
    if(vd && vd.title) {
        result.inlineMetadata = {
            "title": vd.title,
            "description": vd.shortDescription || "",
            "author_name": vd.author || "",
            "author_id": vd.channelId || "",
            "author_url": vd.channelId ? "/channel/" + vd.channelId : "",
            "viewCount": vd.viewCount || 0,
            "length": parseInt(vd.lengthSeconds || 0) || 0,
            "tags": vd.keywords || [],
            "thumbnail": (vd.thumbnail
                       && vd.thumbnail.thumbnails
                       && vd.thumbnail.thumbnails.length)
                       ? vd.thumbnail.thumbnails[
                            vd.thumbnail.thumbnails.length - 1
                         ].url
                       : "",
            "source": "innertube",
            "sources": ["innertube"]
        }
        try {
            result.inlineMetadata.upload = playerResponse.microformat
                .playerMicroformatRenderer.uploadDate
        }
        catch(error) {}
        try {
            result.inlineMetadata.category = playerResponse.microformat
                .playerMicroformatRenderer.category
        }
        catch(error) {}
    }

    // age gates and region blocks are worth retrying with other clients
    result.recoverable = AGE_GATE_STATES.includes(matched)
                      || matched == STATES.REGION_BLOCKED
    // if youtube kept the metadata we don't need to go digging
    result.needsMetadata = !result.hasMetadata

    return result;
}

function applyCopy(result) {
    let copy = STATE_COPY[result.state] || STATE_COPY[STATES.UNAVAILABLE]
    result.headline = copy.headline;
    result.body = copy.body;
    result.playerMessage = copy.player;

    // prefer youtube's own wording when it's more specific than our generic
    // copy (eg "due to a copyright claim by Sony Music Entertainment")
    let specific = result.subreason || result.reason;
    if(specific
    && specific.length > 12
    && result.state !== STATES.AGE_RESTRICTED) {
        result.headline = specific;
        result.playerMessage = specific;
    }
    if(result.state == STATES.AGE_RESTRICTED) {
        // keep 2009 wording, but keep youtube's detail around
        if(result.subreason) {
            result.body = result.subreason;
        }
    }
}

/*
=======
buildVideoData
=======
turns a classification (+ whatever metadata we managed to recover) into
an object shaped exactly like fetch_video_data's normal output, so the
watchpage renderer doesn't need to know anything special happened.
*/
function buildVideoData(id, classification, meta) {
    meta = meta || {}
    let data = {
        "id": id,
        "title": meta.title || "",
        "description": meta.description || "",
        "viewCount": (meta.viewCount || 0).toString(),
        "author_name": meta.author_name || "",
        "author_url": meta.author_url
                   || (meta.author_id ? "/channel/" + meta.author_id : "#"),
        "author_id": meta.author_id || "",
        "author_img": meta.author_img || "default",
        "upload": meta.upload || "",
        "tags": meta.tags || [],
        "related": meta.related || [],
        "comments": meta.comments || [],
        "length": parseInt(meta.length || 0) || 0,
        "category": meta.category || "People & Blogs",
        "qualities": [],
        "extendedItagData": [],
        "rating": meta.rating || 0,
        "ratingCount": meta.ratingCount || 0,
        "commentsDisabled": true,

        // yt2009-internal markers
        "unavailable": true,
        "unavailableState": classification.state,
        "unavailableReason": classification.reason,
        "unavailableSubreason": classification.subreason,
        "unavailableHeadline": classification.headline,
        "unavailableBody": classification.body,
        "unavailablePlayerMessage": classification.playerMessage,
        "unavailableIsAgeGate": AGE_GATE_STATES.includes(classification.state),
        "unavailableIsGone": GONE_STATES.includes(classification.state),
        "unavailableIsBlocked": BLOCKED_STATES.includes(classification.state),
        "metadataSource": meta.source || "none",
        "metadataSources": meta.sources || [],
        "hasRecoveredMetadata": !!(meta.title),

        // never cache a broken fetch as if it were a real one
        "freezeCache": true,
        "freezeSync": true,
        "unplayable": true
    }

    if(!data.title) {
        // nothing anywhere. still render a page, just an empty one.
        data.title = classification.state == STATES.AGE_RESTRICTED
                   ? "Age-restricted video"
                   : "This video is unavailable"
        data.titleIsPlaceholder = true;
    }
    if(!data.author_name) {
        data.author_name = "Unknown"
        data.authorIsPlaceholder = true;
    }
    if(!data.upload) {
        data.upload = new Date().toISOString().split("T")[0]
        data.uploadIsPlaceholder = true;
    }
    if(meta.thumbnail) {
        data.recoveredThumbnail = meta.thumbnail;
    }
    if(meta.archiveYear) {
        data.archiveYear = meta.archiveYear;
    }

    return data;
}

/*
=======
2009-style page furniture
=======
*/

// the big grey/black box that replaces the player
function playerOverlayHtml(data) {
    let message = escapeHtml(data.unavailablePlayerMessage
                          || "This video is unavailable.")
    let extra = ""

    if(data.unavailableIsAgeGate) {
        extra = [
            `<div class="yt2009-unavailable-sub">`,
            escapeHtml(data.unavailableBody
                    || "This video may be inappropriate for some users."),
            `</div>`,
            `<div class="yt2009-unavailable-actions">`,
            `<a href="/mh_pc_intro" class="yt2009-unavailable-link">`,
            `Sign in to confirm your age</a>`,
            `</div>`
        ].join("")
    } else if(data.unavailableIsGone) {
        if(data.hasRecoveredMetadata) {
            extra = [
                `<div class="yt2009-unavailable-sub">`,
                `The video is gone, but its details were recovered`,
                data.metadataSource && data.metadataSource !== "none"
                ? ` from ${escapeHtml(prettySource(data.metadataSource))}`
                : "",
                `.</div>`
            ].join("")
        } else {
            extra = `<div class="yt2009-unavailable-sub">Sorry about that.</div>`
        }
    } else if(data.unavailableBody) {
        extra = `<div class="yt2009-unavailable-sub">`
              + escapeHtml(data.unavailableBody) + `</div>`
    }

    let thumbStyle = ""
    if(data.recoveredThumbnail) {
        thumbStyle = ` style="background-image:url('`
                   + escapeHtml(data.recoveredThumbnail)
                   + `');"`
    }

    return [
        `<div id="watch-player-div" class="yt2009-unavailable-player`,
        data.recoveredThumbnail ? ` has-thumb` : ``,
        `"${thumbStyle} data-yt2009-unavailable-state="`,
        escapeHtml(data.unavailableState), `">`,
            `<div class="yt2009-unavailable-shade"></div>`,
            `<div class="yt2009-unavailable-inner">`,
                `<div class="yt2009-unavailable-msg">`, message, `</div>`,
                extra,
            `</div>`,
        `</div>`
    ].join("")
}

function prettySource(source) {
    const names = {
        "local_cache": "yt2009's own cache",
        "ytdlp": "yt-dlp",
        "youtubei": "InnerTube",
        "innertube_embedded": "the embedded player API",
        "wayback_gdata": "an archived GData API response",
        "wayback_oembed": "an archived oEmbed response",
        "wayback_watchpage": "The Wayback Machine",
        "filmot": "Filmot",
        "fixture": "an offline test fixture"
    }
    return names[source] || source;
}

// a 2009-style yellow warning bar put above the player
function noticeBarHtml(data) {
    let headline = escapeHtml(data.unavailableHeadline || "")
    if(!headline) return "";
    let sources = ""
    if(data.metadataSources && data.metadataSources.length) {
        sources = ` <span class="yt2009-unavailable-src">(details via `
                + escapeHtml(
                      data.metadataSources.map(prettySource).join(", ")
                  )
                + `)</span>`
    }
    return [
        `<div class="yt2009-unavailable-notice yt-alert yt-alert-warn">`,
        `<div class="yt2009-unavailable-notice-inner">`,
        `<strong>`, headline, `</strong>`,
        sources,
        `</div></div>`
    ].join("")
}

/*
=======
recoveredNotice
=======
for videos that *did* end up playing after a restricted-stream recovery.
drops a single line above the player saying what we had to do, so the
age gate bypass is visible instead of silent.
=======
*/
const RECOVERED_COPY = {
    "age_restricted": "This video is age restricted on YouTube.",
    "region_blocked": "This video is blocked in this region on YouTube.",
    "members_only": "This video is members only on YouTube.",
    "login_required": "This video requires a sign in on YouTube."
}
function recoveredNotice(code, data) {
    if(!data || !data.recoveredFrom) return code;
    let line = RECOVERED_COPY[data.recoveredFrom]
            || "YouTube refused to serve this video directly."
    let via = data.recoverySource
            ? ` <span class="yt2009-unavailable-src">(stream recovered `
              + `via ` + escapeHtml(prettySource(data.recoverySource))
              + `)</span>`
            : ""
    let bar = [
        `<div class="yt2009-unavailable-notice `
      + `yt2009-recovered-notice yt-alert yt-alert-warn">`,
        `<div class="yt2009-unavailable-notice-inner">`,
        `<strong>`, escapeHtml(line), `</strong>`,
        via,
        `</div></div>`
    ].join("")

    code = code.replace(`<!--yt2009_notice-->`, bar)
    if(code.includes("</head>") && !code.includes("yt2009-unavailable-notice {")) {
        code = code.replace("</head>", STYLE + "</head>")
    }
    return code;
}

const STYLE = `<style>
.yt2009-unavailable-player {
    position: relative;
    width: 640px;
    height: 385px;
    background-color: #000;
    background-size: cover;
    background-position: center center;
    overflow: hidden;
    font-family: Arial, sans-serif;
}
.yt2009-unavailable-player .yt2009-unavailable-shade {
    position: absolute;
    left: 0; top: 0; width: 100%; height: 100%;
    background-color: #000;
}
.yt2009-unavailable-player.has-thumb .yt2009-unavailable-shade {
    opacity: 0.72;
    filter: alpha(opacity=72);
}
.yt2009-unavailable-inner {
    position: absolute;
    left: 0;
    top: 42%;
    width: 100%;
    text-align: center;
    color: #fff;
}
.yt2009-unavailable-msg {
    font-size: 13px;
    line-height: 18px;
    padding: 0px 40px;
    color: #fff;
}
.yt2009-unavailable-sub {
    font-size: 11px;
    line-height: 16px;
    padding: 6px 40px 0px 40px;
    color: #bbb;
}
.yt2009-unavailable-actions {
    padding-top: 10px;
}
a.yt2009-unavailable-link,
a.yt2009-unavailable-link:visited {
    color: #9cf;
    font-size: 11px;
    text-decoration: underline;
}
.yt2009-unavailable-notice {
    margin: 0px 0px 6px 0px;
    padding: 6px 8px;
    border: 1px solid #e5c74c;
    background-color: #fdf6d8;
    font-size: 12px;
    color: #333;
}
.yt2009-unavailable-notice strong { font-weight: bold; }
.yt2009-unavailable-src { color: #777; font-size: 11px; }
.yt2009-unavailable-meta-note {
    font-size: 11px;
    color: #777;
    padding: 4px 0px;
}
.yt2009-unavailable-hidden { display: none !important; }
</style>`

/*
=======
postProcess
=======
the watchpage renderer is a 3000-line monster and there is no sane place
inside it to branch on "actually there is no video". so instead we let it
build the page as usual with our recovered metadata and then swap the
player out afterwards. works for every template path.
*/
function postProcess(code, data) {
    if(!code || typeof code !== "string") return code;

    // 1. swap the player area out for the error box
    try {
        const anchor = `<div id="watch-this-vid"`
        const endAnchor = `<!-- begin right section -->`
        if(code.includes(anchor) && code.includes(endAnchor)) {
            let head = code.split(anchor)[0]
            let rest = code.substring(head.length + anchor.length)
            let endIndex = rest.indexOf(endAnchor)
            if(endIndex > 0) {
                let playerChunk = rest.substring(0, endIndex)
                let after = rest.substring(endIndex)
                // keep the opening attributes of #watch-this-vid
                let attrEnd = playerChunk.indexOf(">")
                let attrs = attrEnd >= 0
                          ? playerChunk.substring(0, attrEnd + 1)
                          : ` class="yt-rounded">`
                code = head + anchor + attrs
                     + playerOverlayHtml(data)
                     + `</div>`
                     + after;
            }
        } else if(code.includes(`<div id="watch-player-div"`)) {
            // feather / unexpected template - do a narrower swap
            let before = code.split(`<div id="watch-player-div"`)[0]
            let rest = code.substring(
                before.length + `<div id="watch-player-div"`.length
            )
            // player div is always immediately followed by the closing
            // </div> of #watch-this-vid in every yt2009 template
            let close = rest.lastIndexOf(`</div>`)
            if(close > 0) {
                code = before + playerOverlayHtml(data) + rest.substring(close)
            }
        }
    }
    catch(error) {
        console.log("[unavailable] player swap failed", error.message)
    }

    // 2. the html5 player has nothing to attach to anymore
    code = code.split(
        `initPlayer(document.querySelector("#watch-player-div"), true)`
    ).join(`/* yt2009: no player - video unavailable */`)
    code = code.split(`initAsSabr();`).join("")
    code = code.split(`initAsLive();`).join("")
    code = code.split(`showLoadingSprite()`).join("")

    // 3. notice bar above the title
    code = code.replace(`<!--yt2009_notice-->`, noticeBarHtml(data))

    // 4. styles
    if(code.includes("</head>")) {
        code = code.replace("</head>", STYLE + "\n</head>")
    } else {
        code = STYLE + code;
    }

    // 5. a video that doesn't exist can't be rated, shared, favourited
    //    or downloaded. 2009 youtube hid these too.
    code = code.split(`id="watch-actions"`)
               .join(`id="watch-actions" class="yt2009-unavailable-hidden"`)

    return code;
}

module.exports = {
    "postProcess": postProcess,
    "STATES": STATES,
    "AGE_GATE_STATES": AGE_GATE_STATES,
    "GONE_STATES": GONE_STATES,
    "BLOCKED_STATES": BLOCKED_STATES,
    "classify": classify,
    "buildVideoData": buildVideoData,
    "playerOverlayHtml": playerOverlayHtml,
    "noticeBarHtml": noticeBarHtml,
    "recoveredNotice": recoveredNotice,
    "prettySource": prettySource,
    "readText": readText,
    "escapeHtml": escapeHtml,
    "style": STYLE,

    // small helper used by /get_video_info and the gdata endpoints
    "legacyErrorParams": function(data) {
        // 2009 flash players understood status/errorcode/reason
        let errorcode = 150;
        let suberrorcode = 28;
        switch(data.unavailableState) {
            case STATES.AGE_RESTRICTED: {
                errorcode = 150; suberrorcode = 26; break;
            }
            case STATES.PRIVATE: {
                errorcode = 150; suberrorcode = 27; break;
            }
            case STATES.REGION_BLOCKED: {
                errorcode = 150; suberrorcode = 29; break;
            }
            case STATES.COPYRIGHT:
            case STATES.TOS_VIOLATION:
            case STATES.ACCOUNT_TERMINATED: {
                errorcode = 150; suberrorcode = 30; break;
            }
            case STATES.DELETED:
            case STATES.REMOVED_BY_USER: {
                errorcode = 100; suberrorcode = 2; break;
            }
            default: {
                errorcode = 100; suberrorcode = 8; break;
            }
        }
        return [
            "status=fail",
            "errorcode=" + errorcode,
            "suberrorcode=" + suberrorcode,
            "reason=" + encodeURIComponent(
                data.unavailablePlayerMessage || "This video is unavailable."
            ),
            "yt2009_state=" + (data.unavailableState || "unavailable")
        ].join("&")
    }
}
