/*
=======
yt2009recovery.js

digs up whatever is left of a video youtube won't serve us normally.

two jobs:

1. recoverPlayer(id)   - for age restricted (and sometimes region blocked)
                         videos, retry with clients that aren't age gated so
                         we get real metadata AND real streams back.
                         sources, in order:
                            - innertube TVHTML5_SIMPLY_EMBEDDED_PLAYER
                            - innertube WEB_EMBEDDED_PLAYER
                            - innertube MWEB
                            - youtubei.js (TV_EMBEDDED / WEB_EMBEDDED)
                            - yt-dlp (tv_embedded,web_safari,mweb clients)

2. recoverMetadata(id) - for deleted videos. the video is gone, but its
                         metadata usually isn't. sources, in order:
                            - yt2009's own video cache
                            - yt-dlp (occasionally still resolves)
                            - archived gdata api responses (2008-2014, the
                              single best source for 2009-era deletions)
                            - archived oEmbed responses
                            - the wayback machine watchpage parser
                            - filmot (if a key is configured)

every source is independent and failure-tolerant: if a tool isn't installed
or a host is unreachable we just move to the next one.

yt2009, 2022-2033
=======
*/

const fs = require("fs")
const path = require("path")
const child_process = require("child_process")
const fetch = require("node-fetch")

const config = require("./config.json")
const constants = require("./yt2009constants.json")
const unavailable = require("./yt2009unavailable")
const waybackWatchpage = require("./cache_dir/wayback_watchpage")

const CACHE_PATH = path.join(__dirname, "cache_dir", "recovery_cache.json")
const CACHE_TTL = 1000 * 60 * 60 * 24 * 14 // 2 weeks
const NET_TIMEOUT = parseInt(config.recovery_timeout || 12000)
const TOOL_TIMEOUT = parseInt(config.recovery_tool_timeout || 45000)
const DEV = config.env == "dev"

let cache = {}
try {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH).toString())
}
catch(error) {
    cache = {}
}

let cacheDirty = false;
setInterval(() => {
    if(!cacheDirty) return;
    try {
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache))
        cacheDirty = false;
    }
    catch(error) {}
}, 1000 * 60 * 5)

process.on("exit", () => {
    if(!cacheDirty) return;
    try { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache)) }
    catch(error) {}
})

function log() {
    if(!DEV) return;
    console.log.apply(console, ["[recovery]"].concat(
        Array.prototype.slice.call(arguments)
    ))
}

/*
=======
tool detection
=======
*/
let toolState = {
    "ytdlp": {"available": null, "path": config.ytdlp_path || "yt-dlp",
              "version": null},
    "youtubeijs": {"available": null, "version": null},
    "innertube": {"available": true},
    "wayback": {"available": true},
    "filmot": {"available": !!config.filmot_key}
}

function detectYtdlp() {
    if(toolState.ytdlp.available !== null) return toolState.ytdlp.available;
    try {
        let out = child_process.execSync(
            `"${toolState.ytdlp.path}" --version`,
            {"stdio": "pipe", "timeout": 15000}
        ).toString().trim()
        toolState.ytdlp.available = true;
        toolState.ytdlp.version = out;
        log("yt-dlp detected:", out)
    }
    catch(error) {
        toolState.ytdlp.available = false;
        log("yt-dlp not available")
    }
    return toolState.ytdlp.available;
}

let youtubeijs = null;
function detectYoutubeiJs() {
    if(toolState.youtubeijs.available !== null) {
        return toolState.youtubeijs.available;
    }
    try {
        youtubeijs = require("youtubei.js")
        toolState.youtubeijs.available = true;
        try {
            toolState.youtubeijs.version = require(
                "youtubei.js/package.json"
            ).version
        }
        catch(error) {}
        log("youtubei.js detected:", toolState.youtubeijs.version)
    }
    catch(error) {
        toolState.youtubeijs.available = false;
        log("youtubei.js not available")
    }
    return toolState.youtubeijs.available;
}

/*
=======
small utils
=======
*/
function timedFetch(url, options) {
    options = options || {}
    return new Promise((resolve, reject) => {
        let done = false;
        let t = setTimeout(() => {
            if(done) return;
            done = true;
            reject(new Error("timeout"))
        }, options.timeout || NET_TIMEOUT)
        fetch(url, options).then(r => {
            if(done) return;
            done = true;
            clearTimeout(t)
            resolve(r)
        }).catch(error => {
            if(done) return;
            done = true;
            clearTimeout(t)
            reject(error)
        })
    })
}

function safeJson(r) {
    return r.text().then(t => {
        try { return JSON.parse(t) }
        catch(error) { return null }
    })
}

function runSources(sources, onDone) {
    // runs async source fns one by one until one returns something truthy
    let index = 0;
    let tried = []
    function next() {
        if(index >= sources.length) {
            onDone(null, tried)
            return;
        }
        let source = sources[index++]
        let finished = false;
        let guard = setTimeout(() => {
            if(finished) return;
            finished = true;
            tried.push(source.name + ":timeout")
            next()
        }, source.timeout || TOOL_TIMEOUT)
        try {
            source.run((result) => {
                if(finished) return;
                finished = true;
                clearTimeout(guard)
                if(result) {
                    tried.push(source.name + ":hit")
                    result.source = source.name;
                    result.sources = tried.slice()
                    onDone(result, tried)
                } else {
                    tried.push(source.name + ":miss")
                    next()
                }
            })
        }
        catch(error) {
            if(finished) return;
            finished = true;
            clearTimeout(guard)
            tried.push(source.name + ":error")
            log(source.name, "threw", error && error.message)
            next()
        }
    }
    next()
}

function cacheRead(key) {
    let entry = cache[key]
    if(!entry) return null;
    if(Date.now() - entry.t > CACHE_TTL) {
        delete cache[key]
        cacheDirty = true;
        return null;
    }
    return entry.v;
}

function cacheWrite(key, value) {
    cache[key] = {"t": Date.now(), "v": value}
    cacheDirty = true;
}

/*
=======
innertube age-gate clients
=======
*/
const EMBED_CLIENTS = [
    {
        "name": "innertube_tvhtml5_embedded",
        "context": {
            "client": {
                "clientName": "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
                "clientVersion": "2.0",
                "hl": "en",
                "gl": "US",
                "clientScreen": "EMBED"
            },
            "thirdParty": {"embedUrl": "https://www.youtube.com/"}
        },
        "clientNameHeader": "85",
        "clientVersionHeader": "2.0"
    },
    {
        "name": "innertube_web_embedded",
        "context": {
            "client": {
                "clientName": "WEB_EMBEDDED_PLAYER",
                "clientVersion": "1.20240101.00.00",
                "hl": "en",
                "gl": "US",
                "clientScreen": "EMBED"
            },
            "thirdParty": {"embedUrl": "https://www.youtube.com/"}
        },
        "clientNameHeader": "56",
        "clientVersionHeader": "1.20240101.00.00"
    },
    {
        "name": "innertube_mweb",
        "context": {
            "client": {
                "clientName": "MWEB",
                "clientVersion": "2.20240101.00.00",
                "hl": "en",
                "gl": "US"
            }
        },
        "clientNameHeader": "2",
        "clientVersionHeader": "2.20240101.00.00"
    },
    {
        "name": "innertube_ios",
        "context": {
            "client": {
                "clientName": "IOS",
                "clientVersion": "19.29.1",
                "deviceMake": "Apple",
                "deviceModel": "iPhone16,2",
                "osName": "iPhone",
                "osVersion": "17.5.1.21F90",
                "hl": "en",
                "gl": "US"
            }
        },
        "clientNameHeader": "5",
        "clientVersionHeader": "19.29.1",
        "userAgent": "com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)"
    }
]

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"

function innertubePlayer(id, client, callback) {
    let url = `https://www.youtube.com/youtubei/v1/player`
            + `?key=${INNERTUBE_KEY}&prettyPrint=false`
    let headers = {
        "content-type": "application/json",
        "x-youtube-client-name": client.clientNameHeader,
        "x-youtube-client-version": client.clientVersionHeader,
        "origin": "https://www.youtube.com",
        "user-agent": client.userAgent
                   || (constants.headers && constants.headers["user-agent"])
                   || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) yt2009"
    }
    let body = {
        "context": JSON.parse(JSON.stringify(client.context)),
        "videoId": id,
        "contentCheckOk": true,
        "racyCheckOk": true,
        "playbackContext": {
            "contentPlaybackContext": {
                "html5Preference": "HTML5_PREF_WANTS",
                "signatureTimestamp": 20073
            }
        }
    }
    timedFetch(url, {
        "method": "POST",
        "headers": headers,
        "body": JSON.stringify(body)
    }).then(r => safeJson(r)).then(r => {
        callback(r)
    }).catch(error => {
        log(client.name, "failed:", error && error.message)
        callback(null)
    })
}

/*
=======
youtubei.js
=======
*/
let youtubeiInstance = null;
let youtubeiInstancePromise = null;
function getYoutubeiInstance() {
    if(youtubeiInstance) return Promise.resolve(youtubeiInstance)
    if(youtubeiInstancePromise) return youtubeiInstancePromise;
    youtubeiInstancePromise = youtubeijs.Innertube.create({
        "retrieve_player": false,
        "generate_session_locally": true
    }).then(inst => {
        youtubeiInstance = inst;
        return inst;
    })
    return youtubeiInstancePromise;
}

function youtubeiGetInfo(id, client, callback) {
    if(!detectYoutubeiJs()) {
        callback(null)
        return;
    }
    getYoutubeiInstance().then(inst => {
        return inst.getBasicInfo(id, client)
    }).then(info => {
        if(!info) { callback(null); return; }
        // youtubei.js hands back a parsed object; re-shape it into
        // something that walks and quacks like a player response
        let page = info.page && info.page[0] ? info.page[0] : {}
        let out = {
            "playabilityStatus": page.playability_status
                ? {
                    "status": page.playability_status.status,
                    "reason": page.playability_status.reason,
                    "subreason": page.playability_status.error_screen
                              && page.playability_status.error_screen.subreason
                              ? page.playability_status.error_screen
                                    .subreason.toString()
                              : undefined
                  }
                : {"status": "OK"},
            "videoDetails": info.basic_info ? {
                "videoId": info.basic_info.id || id,
                "title": info.basic_info.title,
                "shortDescription": info.basic_info.short_description,
                "lengthSeconds": (info.basic_info.duration || 0).toString(),
                "viewCount": (info.basic_info.view_count || 0).toString(),
                "author": info.basic_info.author,
                "channelId": info.basic_info.channel_id,
                "keywords": info.basic_info.keywords || [],
                "isLive": !!info.basic_info.is_live,
                "thumbnail": info.basic_info.thumbnail
                    ? {"thumbnails": info.basic_info.thumbnail}
                    : undefined
            } : undefined,
            "streamingData": info.streaming_data
                ? JSON.parse(JSON.stringify(info.streaming_data))
                : undefined,
            "microformat": page.microformat
                ? JSON.parse(JSON.stringify(page.microformat))
                : undefined
        }
        callback(out)
    }).catch(error => {
        log("youtubei.js failed:", error && error.message)
        callback(null)
    })
}

/*
=======
yt-dlp
=======
*/
function runYtdlp(args, callback) {
    if(!detectYtdlp()) {
        callback(null)
        return;
    }
    let proc;
    try {
        proc = child_process.spawn(toolState.ytdlp.path, args, {
            "stdio": ["ignore", "pipe", "pipe"]
        })
    }
    catch(error) {
        callback(null)
        return;
    }
    let out = ""
    let err = ""
    let done = false;
    let killer = setTimeout(() => {
        if(done) return;
        try { proc.kill("SIGKILL") } catch(error) {}
    }, TOOL_TIMEOUT)

    proc.stdout.on("data", d => {out += d.toString()})
    proc.stderr.on("data", d => {err += d.toString()})
    proc.on("error", () => {
        if(done) return;
        done = true;
        clearTimeout(killer)
        callback(null)
    })
    proc.on("close", () => {
        if(done) return;
        done = true;
        clearTimeout(killer)
        if(err && DEV) {
            log("yt-dlp stderr:", err.trim().split("\n").slice(0, 3).join(" | "))
        }
        let parsed = null;
        // yt-dlp can print warnings before the json; take the last json line
        out.trim().split("\n").forEach(line => {
            line = line.trim()
            if(!line.startsWith("{")) return;
            try { parsed = JSON.parse(line) }
            catch(error) {}
        })
        callback(parsed)
    })
}

function ytdlpBaseArgs(id) {
    return [
        "-J",
        "--no-warnings",
        "--skip-download",
        "--no-playlist",
        "--no-call-home",
        "--ignore-no-formats-error",
        "--socket-timeout", "15",
        "--retries", "1"
    ].concat(
        config.ytdlp_cookies
        ? ["--cookies", config.ytdlp_cookies]
        : []
    ).concat(
        config.ytdlp_cookies_from_browser
        ? ["--cookies-from-browser", config.ytdlp_cookies_from_browser]
        : []
    ).concat([
        "--extractor-args",
        config.ytdlp_player_clients
        ? `youtube:player_client=${config.ytdlp_player_clients}`
        : "youtube:player_client=tv_simply,web_safari,mweb,tv_embedded",
        `https://www.youtube.com/watch?v=${id}`
    ])
}

// turn a yt-dlp info dict into a player-response-ish object
function ytdlpToPlayerResponse(info, id) {
    if(!info) return null;
    let formats = (info.formats || []).filter(f => {
        return f.url && f.protocol && f.protocol.indexOf("http") === 0
    })
    let progressive = formats.filter(f => {
        return f.vcodec && f.vcodec !== "none"
            && f.acodec && f.acodec !== "none"
    })
    let adaptive = formats.filter(f => {
        return !(f.vcodec && f.vcodec !== "none"
             && f.acodec && f.acodec !== "none")
    })
    function mapFormat(f) {
        return {
            "itag": parseInt(f.format_id) || 0,
            "url": f.url,
            "mimeType": [
                f.vcodec && f.vcodec !== "none" ? "video" : "audio",
                "/",
                (f.ext == "m4a" ? "mp4" : f.ext || "mp4"),
                '; codecs="',
                [
                    f.vcodec && f.vcodec !== "none" ? f.vcodec : null,
                    f.acodec && f.acodec !== "none" ? f.acodec : null
                ].filter(s => s).join(", "),
                '"'
            ].join(""),
            "bitrate": f.tbr ? Math.floor(f.tbr * 1000) : undefined,
            "width": f.width,
            "height": f.height,
            "contentLength": f.filesize
                           ? f.filesize.toString()
                           : (f.filesize_approx
                              ? Math.floor(f.filesize_approx).toString()
                              : undefined),
            "qualityLabel": f.height ? f.height + "p" : undefined,
            "fps": f.fps,
            "audioQuality": f.abr
                          ? (f.abr > 100 ? "AUDIO_QUALITY_MEDIUM"
                                         : "AUDIO_QUALITY_LOW")
                          : undefined,
            "approxDurationMs": info.duration
                              ? Math.floor(info.duration * 1000).toString()
                              : undefined
        }
    }
    let out = {
        "playabilityStatus": {"status": formats.length ? "OK" : "UNPLAYABLE"},
        "videoDetails": {
            "videoId": info.id || id,
            "title": info.title || info.fulltitle || "",
            "shortDescription": info.description || "",
            "lengthSeconds": (info.duration || 0).toString(),
            "viewCount": (info.view_count || 0).toString(),
            "author": info.uploader || info.channel || "",
            "channelId": info.channel_id || info.uploader_id || "",
            "keywords": info.tags || [],
            "isLive": !!info.is_live,
            "thumbnail": info.thumbnail
                ? {"thumbnails": [{"url": info.thumbnail}]}
                : undefined
        },
        "streamingData": formats.length ? {
            "expiresInSeconds": "21540",
            "formats": progressive.map(mapFormat),
            "adaptiveFormats": adaptive.map(mapFormat)
        } : undefined,
        "microformat": {
            "playerMicroformatRenderer": {
                "uploadDate": info.upload_date
                    ? [
                        info.upload_date.substring(0, 4),
                        info.upload_date.substring(4, 6),
                        info.upload_date.substring(6, 8)
                      ].join("-")
                    : undefined,
                "category": info.categories && info.categories[0]
                          ? info.categories[0]
                          : undefined,
                "ownerChannelName": info.uploader || info.channel,
                "viewCount": info.view_count
                           ? info.view_count.toString()
                           : undefined
            }
        },
        "yt2009RecoverySource": "ytdlp"
    }
    if(!out.videoDetails.title) return null;
    return out;
}

/*
=======
metadata-only sources (for deleted videos)
=======
*/

// 1. our own cache - fastest and most likely for a video that used to work
function sourceLocalCache(id) {
    return {
        "name": "local_cache",
        "timeout": 1000,
        "run": function(done) {
            let videoCache;
            try { videoCache = require("./cache_dir/video_cache_manager") }
            catch(error) { done(null); return; }
            let v = videoCache.read()[id]
            if(!v || !v.title || v.unavailable) { done(null); return; }
            done({
                "title": v.title,
                "description": v.description,
                "author_name": v.author_name,
                "author_url": v.author_url,
                "author_id": v.author_id,
                "author_img": v.author_img,
                "viewCount": v.viewCount,
                "upload": v.upload,
                "length": v.length,
                "tags": v.tags || [],
                "category": v.category,
                "related": v.related || [],
                "comments": v.comments || []
            })
        }
    }
}

// 2. yt-dlp - sometimes resolves metadata for things innertube won't
function sourceYtdlp(id) {
    return {
        "name": "ytdlp",
        "run": function(done) {
            if(!detectYtdlp()) { done(null); return; }
            runYtdlp(ytdlpBaseArgs(id), (info) => {
                if(!info || !info.title) { done(null); return; }
                done({
                    "title": info.title,
                    "description": info.description || "",
                    "author_name": info.uploader || info.channel || "",
                    "author_id": info.channel_id || "",
                    "author_url": info.channel_id
                                ? "/channel/" + info.channel_id : "",
                    "viewCount": info.view_count || 0,
                    "upload": info.upload_date
                        ? [
                            info.upload_date.substring(0, 4),
                            info.upload_date.substring(4, 6),
                            info.upload_date.substring(6, 8)
                          ].join("-")
                        : "",
                    "length": info.duration || 0,
                    "tags": info.tags || [],
                    "category": info.categories && info.categories[0],
                    "thumbnail": info.thumbnail
                })
            })
        }
    }
}

// 3. archived gdata api responses.
// gdata carried everything 2009 yt2009 wants and the archive is full of it.
function sourceWaybackGdata(id) {
    return {
        "name": "wayback_gdata",
        "timeout": NET_TIMEOUT * 2,
        "run": function(done) {
            const targets = [
                `http://gdata.youtube.com/feeds/api/videos/${id}?v=2&alt=json`,
                `http://gdata.youtube.com/feeds/api/videos/${id}?alt=json`,
                `http://gdata.youtube.com/feeds/api/videos/${id}`
            ]
            let i = 0;
            function tryNext() {
                if(i >= targets.length) { done(null); return; }
                let target = targets[i++]
                let url = `https://web.archive.org/web/2012id_/`
                        + encodeURI(target)
                timedFetch(url, {
                    "headers": {"user-agent": "yt2009 recovery"}
                }).then(r => {
                    if(!r || r.status >= 400) throw new Error("no snapshot");
                    return r.text()
                }).then(text => {
                    let parsed = parseGdata(text)
                    if(parsed && parsed.title) { done(parsed) }
                    else { tryNext() }
                }).catch(() => {tryNext()})
            }
            tryNext()
        }
    }
}

function parseGdata(text) {
    if(!text) return null;
    // json flavour
    if(text.trim().startsWith("{")) {
        let j;
        try { j = JSON.parse(text) }
        catch(error) { return null }
        let e = j.entry || (j.feed && j.feed.entry && j.feed.entry[0])
        if(!e) return null;
        let media = e["media$group"] || {}
        let stats = e["yt$statistics"] || {}
        let rating = e["gd$rating"] || {}
        return {
            "title": (media["media$title"] && media["media$title"].$t)
                  || (e.title && (e.title.$t || e.title)) || "",
            "description": (media["media$description"]
                         && media["media$description"].$t) || "",
            "author_name": (e.author && e.author[0] && e.author[0].name
                         && e.author[0].name.$t) || "",
            "author_url": (e.author && e.author[0] && e.author[0].name
                        && e.author[0].name.$t)
                        ? "/user/" + e.author[0].name.$t : "",
            "author_id": (e.author && e.author[0] && e.author[0]["yt$userId"]
                       && e.author[0]["yt$userId"].$t) || "",
            "viewCount": parseInt(stats.viewCount || 0) || 0,
            "upload": (media["yt$uploaded"] && media["yt$uploaded"].$t)
                   || (e.published && e.published.$t) || "",
            "length": parseInt(
                (media["yt$duration"] && media["yt$duration"].seconds) || 0
            ) || 0,
            "tags": (media["media$keywords"] && media["media$keywords"].$t
                    ? media["media$keywords"].$t.split(",").map(s => s.trim())
                    : []),
            "category": (media["media$category"]
                      && media["media$category"][0]
                      && (media["media$category"][0].label
                       || media["media$category"][0].$t)) || "",
            "rating": parseFloat(rating.average || 0) || 0,
            "ratingCount": parseInt(rating.numRaters || 0) || 0,
            "thumbnail": (media["media$thumbnail"]
                       && media["media$thumbnail"][0]
                       && media["media$thumbnail"][0].url) || ""
        }
    }
    // xml flavour
    function tag(name) {
        let m = text.match(new RegExp(
            "<" + name + "[^>]*>([\\s\\S]*?)<\\/" + name + ">"
        ))
        return m ? m[1].trim() : ""
    }
    function attr(name, attribute) {
        let m = text.match(new RegExp(
            "<" + name + "[^>]*\\b" + attribute + "=['\"]([^'\"]*)['\"]"
        ))
        return m ? m[1] : ""
    }
    let title = tag("media:title") || tag("title")
    if(!title) return null;
    return {
        "title": title.replace(/<[^>]+>/g, ""),
        "description": (tag("media:description") || tag("content"))
                        .replace(/<[^>]+>/g, ""),
        "author_name": tag("name"),
        "author_url": tag("name") ? "/user/" + tag("name") : "",
        "viewCount": parseInt(attr("yt:statistics", "viewCount") || 0) || 0,
        "upload": tag("yt:uploaded") || tag("published"),
        "length": parseInt(attr("yt:duration", "seconds") || 0) || 0,
        "tags": tag("media:keywords")
              ? tag("media:keywords").split(",").map(s => s.trim())
              : [],
        "category": attr("media:category", "label") || tag("media:category"),
        "rating": parseFloat(attr("gd:rating", "average") || 0) || 0,
        "ratingCount": parseInt(attr("gd:rating", "numRaters") || 0) || 0,
        "thumbnail": attr("media:thumbnail", "url")
    }
}

// 4. archived oEmbed - tiny but reliable, has title + author
function sourceWaybackOembed(id) {
    return {
        "name": "wayback_oembed",
        "timeout": NET_TIMEOUT * 2,
        "run": function(done) {
            let target = `https://www.youtube.com/oembed`
                       + `?url=http://www.youtube.com/watch%3Fv%3D${id}`
                       + `&format=json`
            let url = `https://web.archive.org/web/2016id_/` + target;
            timedFetch(url, {
                "headers": {"user-agent": "yt2009 recovery"}
            }).then(r => {
                if(!r || r.status >= 400) throw new Error("no snapshot");
                return r.text()
            }).then(text => {
                let j;
                try { j = JSON.parse(text) }
                catch(error) { done(null); return; }
                if(!j || !j.title) { done(null); return; }
                done({
                    "title": j.title,
                    "author_name": j.author_name || "",
                    "author_url": j.author_url
                        ? j.author_url.split("youtube.com")[1] || ""
                        : "",
                    "thumbnail": j.thumbnail_url || "",
                    "description": ""
                })
            }).catch(() => {done(null)})
        }
    }
}

// 5. the wayback watchpage parser yt2009 already ships
function sourceWaybackWatchpage(id) {
    return {
        "name": "wayback_watchpage",
        "timeout": NET_TIMEOUT * 3,
        "run": function(done) {
            let answered = false;
            try {
                waybackWatchpage.read(id, (wb) => {
                    if(answered) return;
                    answered = true;
                    if(!wb || !wb.title) { done(null); return; }
                    done({
                        "title": wb.title,
                        "description": (wb.description || "")
                                        .replace(/<[^>]+>/g, " ")
                                        .replace(/\s+/g, " ").trim(),
                        "author_name": wb.authorName || "",
                        "author_url": "",
                        "author_img": wb.authorAvatar || "",
                        "tags": wb.tags || [],
                        "archiveYear": wb.archiveYear,
                        "comments": (wb.comments || []).map(c => {
                            return {
                                "authorName": c.authorName,
                                "authorUrl": c.authorUrl,
                                "time": c.time,
                                "content": c.content,
                                "likes": c.likes
                            }
                        }),
                        "related": (wb.related || []).map(v => {
                            return {
                                "id": v.id,
                                "title": v.title,
                                "length": v.time,
                                "views": v.viewCount || "0",
                                "creatorName": v.uploaderName,
                                "creatorUrl": v.uploaderUrl
                            }
                        }).filter(v => {return v.id && v.id.length == 11})
                    })
                })
            }
            catch(error) {
                if(!answered) { answered = true; done(null) }
            }
        }
    }
}

// 6. filmot - a dedicated index of deleted youtube videos. needs a key.
function sourceFilmot(id) {
    return {
        "name": "filmot",
        "run": function(done) {
            if(!config.filmot_key) { done(null); return; }
            let url = `https://filmot.com/api/getvideos`
                    + `?key=${encodeURIComponent(config.filmot_key)}`
                    + `&id=${id}&flags=1`
            timedFetch(url, {
                "headers": {"user-agent": "yt2009 recovery"}
            }).then(r => safeJson(r)).then(j => {
                let v = Array.isArray(j) ? j[0] : (j && j.video)
                if(!v || !v.title) { done(null); return; }
                done({
                    "title": v.title,
                    "description": v.description || "",
                    "author_name": v.channelname || v.uploader || "",
                    "author_id": v.channelid || "",
                    "author_url": v.channelid ? "/channel/" + v.channelid : "",
                    "viewCount": parseInt(v.viewcount || 0) || 0,
                    "upload": v.uploaddate || "",
                    "length": parseInt(v.duration || 0) || 0,
                    "tags": v.tags
                        ? (Array.isArray(v.tags) ? v.tags : v.tags.split(","))
                        : [],
                    "category": v.category || ""
                })
            }).catch(() => {done(null)})
        }
    }
}

// archived thumbnail - purely cosmetic but makes the page feel real
function recoverThumbnail(id, callback) {
    let cached = cacheRead("thumb/" + id)
    if(cached !== null && cached !== undefined) {
        callback(cached || null)
        return;
    }
    let candidates = [
        `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        `https://web.archive.org/web/2012im_/http://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        `https://web.archive.org/web/2012im_/http://i.ytimg.com/vi/${id}/0.jpg`
    ]
    let i = 0;
    function tryNext() {
        if(i >= candidates.length) {
            cacheWrite("thumb/" + id, "")
            callback(null)
            return;
        }
        let url = candidates[i++]
        timedFetch(url, {
            "method": "GET",
            "headers": {"user-agent": "yt2009 recovery"},
            "timeout": 8000
        }).then(r => {
            if(!r || r.status >= 400) throw new Error("miss");
            return r.buffer()
        }).then(buf => {
            // youtube serves a 120x90 grey placeholder for dead ids
            if(!buf || buf.length < 2500) throw new Error("placeholder");
            cacheWrite("thumb/" + id, url)
            callback(url)
        }).catch(() => {tryNext()})
    }
    tryNext()
}

/*
=======
public: recoverPlayer
=======
for age restricted / region blocked videos. tries to come back with a
player response that actually has streams in it.
*/
function recoverPlayer(id, options, callback) {
    if(typeof options == "function") {
        callback = options;
        options = {}
    }
    options = options || {}

    const fixtures = require("./yt2009fixtures")
    if(fixtures.enabled()) {
        let f = fixtures.recoveredPlayer(id)
        if(f) {
            log(id, "player recovered from fixture")
            callback(f, "fixture")
            return;
        }
        if(fixtures.isOfflineOnly()) {
            callback(null, "none")
            return;
        }
    }

    let sources = []

    EMBED_CLIENTS.forEach(client => {
        sources.push({
            "name": client.name,
            "timeout": NET_TIMEOUT + 2000,
            "run": function(done) {
                innertubePlayer(id, client, (r) => {
                    if(!r) { done(null); return; }
                    let c = unavailable.classify(r)
                    if(c.ok && c.hasStreams) {
                        r.yt2009RecoverySource = client.name;
                        done(r)
                    } else if(c.hasMetadata && options.acceptMetadataOnly) {
                        r.yt2009RecoverySource = client.name;
                        done(r)
                    } else {
                        done(null)
                    }
                })
            }
        })
    })

    if(detectYoutubeiJs()) {
        ;["TV_EMBEDDED", "WEB_EMBEDDED", "IOS"].forEach(client => {
            sources.push({
                "name": "youtubei_" + client.toLowerCase(),
                "timeout": NET_TIMEOUT + 5000,
                "run": function(done) {
                    youtubeiGetInfo(id, client, (r) => {
                        if(!r) { done(null); return; }
                        let c = unavailable.classify(r)
                        if(c.ok && (c.hasStreams || options.acceptMetadataOnly)) {
                            r.yt2009RecoverySource = "youtubei_"
                                                   + client.toLowerCase()
                            done(r)
                        } else {
                            done(null)
                        }
                    })
                }
            })
        })
    }

    if(detectYtdlp()) {
        sources.push({
            "name": "ytdlp",
            "timeout": TOOL_TIMEOUT,
            "run": function(done) {
                runYtdlp(ytdlpBaseArgs(id), (info) => {
                    let r = ytdlpToPlayerResponse(info, id)
                    if(!r) { done(null); return; }
                    let c = unavailable.classify(r)
                    if(c.hasStreams || options.acceptMetadataOnly) {
                        done(r)
                    } else {
                        done(null)
                    }
                })
            }
        })
    }

    runSources(sources, (result, tried) => {
        log(id, "player recovery:", tried.join(" -> "))
        callback(result, result ? result.source : "none", tried)
    })
}

/*
=======
public: attemptRestrictedRecovery
=======
the one entry point the watchpage pipeline uses: hand it whatever youtube
said and it hands back either the same thing (nothing to do / nothing
worked) or a repaired player response with real streams spliced in.
*/
function attemptRestrictedRecovery(id, playerResponse, options, callback) {
    if(typeof options == "function") {
        callback = options;
        options = {}
    }
    options = options || {}

    if(config.disable_restricted_recovery) {
        callback(playerResponse, null)
        return;
    }

    let classification = unavailable.classify(playerResponse)
    if(classification.ok || !classification.recoverable) {
        callback(playerResponse, null)
        return;
    }

    if(DEV) {
        log(id, classification.state, "- attempting stream recovery")
    }

    recoverPlayer(id, {"acceptMetadataOnly": true}, (recovered, source) => {
        if(!recovered) {
            if(DEV) log(id, "no client could recover it")
            if(playerResponse && typeof playerResponse == "object") {
                playerResponse.yt2009RecoveryFailed = true;
                playerResponse.yt2009RestrictedState = classification.state;
            }
            callback(playerResponse, null)
            return;
        }
        if(DEV) log(id, "recovered via", source)

        let merged = (playerResponse && typeof playerResponse == "object")
                   ? JSON.parse(JSON.stringify(playerResponse))
                   : {}
        merged.playabilityStatus = recovered.playabilityStatus
                                || {"status": "OK"}
        if(recovered.videoDetails) merged.videoDetails = recovered.videoDetails;
        if(recovered.streamingData) {
            merged.streamingData = recovered.streamingData;
        }
        if(recovered.microformat && !merged.microformat) {
            merged.microformat = recovered.microformat;
        }
        if(recovered.captions && !merged.captions) {
            merged.captions = recovered.captions;
        }
        merged.yt2009RecoverySource = source;
        merged.yt2009WasRestricted = true;
        merged.yt2009RestrictedState = classification.state;
        callback(merged, source)
    })
}

/*
=======
public: recoverMetadata
=======
for videos that are gone. comes back with whatever we could scrape together.
*/
function recoverMetadata(id, options, callback) {
    if(typeof options == "function") {
        callback = options;
        options = {}
    }
    options = options || {}

    const fixtures = require("./yt2009fixtures")
    if(fixtures.enabled()) {
        let f = fixtures.recoveredMetadata(id)
        if(f) {
            log(id, "metadata recovered from fixture")
            callback(f)
            return;
        }
        if(fixtures.isOfflineOnly()) {
            callback(null)
            return;
        }
    }

    let cached = cacheRead("meta/" + id)
    if(cached && !options.resetCache) {
        log(id, "metadata from recovery cache")
        callback(cached)
        return;
    }

    let sources = [
        sourceLocalCache(id)
    ]
    if(config.recovery_disable_ytdlp !== true) {
        sources.push(sourceYtdlp(id))
    }
    if(config.recovery_disable_wayback !== true) {
        sources.push(sourceWaybackGdata(id))
        sources.push(sourceWaybackOembed(id))
        sources.push(sourceWaybackWatchpage(id))
    }
    sources.push(sourceFilmot(id))

    runSources(sources, (result, tried) => {
        log(id, "metadata recovery:", tried.join(" -> "))
        if(!result) {
            cacheWrite("meta/" + id, null)
            callback(null, tried)
            return;
        }
        result.sources = tried.filter(s => {return s.endsWith(":hit")})
                              .map(s => {return s.split(":")[0]})
        // try to glue a thumbnail on for the player backdrop
        if(result.thumbnail) {
            cacheWrite("meta/" + id, result)
            callback(result, tried)
            return;
        }
        recoverThumbnail(id, (thumb) => {
            if(thumb) result.thumbnail = thumb;
            cacheWrite("meta/" + id, result)
            callback(result, tried)
        })
    })
}

/*
=======
public: status - for the diagnostics page
=======
*/
function toolStatus() {
    detectYtdlp()
    detectYoutubeiJs()
    const fixtures = require("./yt2009fixtures")
    return {
        "yt-dlp": {
            "available": toolState.ytdlp.available,
            "version": toolState.ytdlp.version,
            "path": toolState.ytdlp.path,
            "purpose": "age gate bypass + leftover metadata"
        },
        "youtubei.js": {
            "available": toolState.youtubeijs.available,
            "version": toolState.youtubeijs.version,
            "purpose": "TV_EMBEDDED / WEB_EMBEDDED / IOS player clients"
        },
        "innertube embedded clients": {
            "available": true,
            "clients": EMBED_CLIENTS.map(c => {return c.name}),
            "purpose": "primary age gate bypass"
        },
        "wayback machine": {
            "available": config.recovery_disable_wayback !== true,
            "purpose": "archived gdata / oembed / watchpage metadata"
        },
        "filmot": {
            "available": !!config.filmot_key,
            "purpose": "deleted video index (set config.filmot_key)"
        },
        "offline fixtures": {
            "available": fixtures.enabled(),
            "ids": fixtures.enabled() ? fixtures.list() : [],
            "purpose": "test deleted/age restricted pages without youtube"
        }
    }
}

module.exports = {
    "recoverPlayer": recoverPlayer,
    "attemptRestrictedRecovery": attemptRestrictedRecovery,
    "recoverMetadata": recoverMetadata,
    "recoverThumbnail": recoverThumbnail,
    "toolStatus": toolStatus,
    "detectYtdlp": detectYtdlp,
    "detectYoutubeiJs": detectYoutubeiJs,
    "ytdlpToPlayerResponse": ytdlpToPlayerResponse,
    "parseGdata": parseGdata,
    "EMBED_CLIENTS": EMBED_CLIENTS,
    "clearCache": function() {
        cache = {}
        cacheDirty = true;
    }
}
