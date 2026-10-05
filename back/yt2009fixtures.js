/*
=======
yt2009fixtures.js

offline test fixtures for the deleted / age restricted watchpage work.

youtube is not always reachable (CI boxes, sandboxes, airgapped setups,
google being google) and you can't exactly rely on a specific real video
staying deleted-but-with-metadata forever. so every failure mode this
branch handles also ships as a canned innertube response.

enable with either:
    - config.offline_fixtures = true          (back/config.json)
    - YT2009_FIXTURES=1                       (environment)

and additionally, to never touch the network at all:
    - config.offline_fixtures_only = true
    - YT2009_OFFLINE=1

then just open /watch?v=<fixture id>. /recovery_test lists them all.

yt2009, 2022-2033
=======
*/

const fs = require("fs")
const path = require("path")

let config = {}
try { config = require("./config.json") }
catch(error) {}

const FIXTURE_DIR = path.join(__dirname, "fixtures")

let loaded = null;

function enabled() {
    if(process.env.YT2009_FIXTURES == "1") return true;
    if(process.env.YT2009_OFFLINE == "1") return true;
    return config.offline_fixtures === true
        || config.offline_fixtures_only === true;
}

function isOfflineOnly() {
    if(process.env.YT2009_OFFLINE == "1") return true;
    return config.offline_fixtures_only === true;
}

function load() {
    if(loaded) return loaded;
    loaded = {}
    let files = []
    try { files = fs.readdirSync(FIXTURE_DIR) }
    catch(error) { return loaded }
    files.forEach(file => {
        if(!file.endsWith(".json")) return;
        try {
            let data = JSON.parse(
                fs.readFileSync(path.join(FIXTURE_DIR, file)).toString()
            )
            if(data && data.id) {
                loaded[data.id] = data;
            }
        }
        catch(error) {
            console.log("[fixtures] could not read " + file, error.message)
        }
    })
    return loaded;
}

function reload() {
    loaded = null;
    return load()
}

function has(id) {
    if(!enabled()) return false;
    return !!load()[id]
}

function get(id) {
    if(!enabled()) return null;
    return load()[id] || null;
}

// the response /player + /next would have produced
function combinedResponse(id) {
    let f = get(id)
    if(!f) return null;
    let out = JSON.parse(JSON.stringify(f.player || {}))
    if(f.next) {
        for(let key in f.next) {
            out[key] = f.next[key]
        }
    }
    out.isFixture = true;
    out.yt2009FixtureId = id;
    return out;
}

// what the recovery clients would have come back with, if anything
function recoveredPlayer(id) {
    let f = get(id)
    if(!f || !f.recoveredPlayer) return null;
    let out = JSON.parse(JSON.stringify(f.recoveredPlayer))
    out.isFixture = true;
    out.yt2009RecoverySource = f.recoveredPlayerSource || "fixture"
    return out;
}

// what the metadata diggers would have come back with, if anything
function recoveredMetadata(id) {
    let f = get(id)
    if(!f || !f.recoveredMetadata) return null;
    let out = JSON.parse(JSON.stringify(f.recoveredMetadata))
    out.source = f.recoveredMetadataSource || "fixture"
    out.sources = f.recoveredMetadataSources || [out.source]
    return out;
}

// fixtures that ship a playable file (so the "recovery succeeded" case
// can actually be watched instead of just claimed)
function mediaPath(id) {
    if(!enabled()) return null;
    let p = path.join(FIXTURE_DIR, "fixture-media", id + ".mp4")
    try {
        if(fs.existsSync(p)) return p;
    }
    catch(error) {}
    return null;
}

function list() {
    if(!enabled()) return []
    let all = load()
    return Object.keys(all).map(id => {
        return {
            "id": id,
            "label": all[id].label || id,
            "describes": all[id].describes || "",
            "expect": all[id].expect || "",
            "hasRecoveredPlayer": !!all[id].recoveredPlayer,
            "hasRecoveredMetadata": !!all[id].recoveredMetadata
        }
    }).sort((a, b) => {return a.id < b.id ? -1 : 1})
}

module.exports = {
    "enabled": enabled,
    "isOfflineOnly": isOfflineOnly,
    "has": has,
    "get": get,
    "combinedResponse": combinedResponse,
    "recoveredPlayer": recoveredPlayer,
    "recoveredMetadata": recoveredMetadata,
    "list": list,
    "mediaPath": mediaPath,
    "reload": reload,
    "dir": FIXTURE_DIR
}
