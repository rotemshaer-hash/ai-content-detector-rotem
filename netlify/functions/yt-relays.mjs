// netlify/functions/yt-relays.mjs
//
// Hands the browser a current list of Piped API hosts. Nothing else — no video
// id, no media, no idea which video anyone is looking at. The browser does the
// actual YouTube fetching itself, because its address is the one YouTube
// serves; this function exists only because the browser cannot read the public
// instance directories (they send no CORS headers, measured on a real phone,
// where every Invidious host and Piped's own directory came back unreachable).
//
// Why a directory at all: measured on that phone, only 2 of 9 hardcoded Piped
// hosts were reachable, and YouTube had bot-blocked both for the video being
// tried. Volunteers add and retire instances constantly, so a list baked into
// the page is stale the week after it ships. This keeps it fresh without
// putting our server anywhere near the video.

const SOURCES = [
  // The project's own directory, newest first.
  { url: "https://piped-instances.kavin.rocks/", parse: parseInstancesJson },
  // Its documentation table, which survives when the API host is down.
  {
    url: "https://raw.githubusercontent.com/TeamPiped/documentation/main/content/docs/public-instances/index.md",
    parse: parseInstancesMarkdown,
  },
];

// Kept as a floor, not as the answer: if every source is unreachable the
// browser still gets something to try rather than an empty list.
const FALLBACK = [
  "https://api.piped.private.coffee",
  "https://pipedapi.ducks.party",
  "https://pipedapi.r4fo.com",
  "https://pipedapi.smnz.de",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.kavin.rocks",
];

function parseInstancesJson(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) return [];
  return data.map((x) => x && (x.api_url || x.apiUrl)).filter(Boolean);
}

// The docs page is a markdown table whose second column is the API URL.
function parseInstancesMarkdown(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    for (const cell of cells) {
      const m = cell.match(/https:\/\/[^\s|)\]]+/);
      if (m && /api|pipedapi/i.test(m[0])) out.push(m[0]);
    }
  }
  return out;
}

function normalise(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    let u;
    try {
      u = new URL(String(raw).trim());
    } catch {
      continue;
    }
    if (u.protocol !== "https:") continue; // the page is https; http hosts are unusable from it
    const base = "https://" + u.hostname.toLowerCase();
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(base);
  }
  return out;
}

export default async () => {
  const headers = {
    "content-type": "application/json",
    "Access-Control-Allow-Origin": "*",
    // A list this stable does not need to be fetched on every paste, and a
    // stale-while-revalidate window means a slow directory never blocks a user.
    "Cache-Control": "public, max-age=1800, stale-while-revalidate=86400",
  };

  const notes = [];
  let collected = [];

  for (const src of SOURCES) {
    try {
      const r = await fetch(src.url, { headers: { "User-Agent": "ai-content-detector" } });
      if (!r.ok) {
        notes.push(new URL(src.url).hostname + ": http " + r.status);
        continue;
      }
      const parsed = src.parse(await r.text());
      if (parsed.length) {
        collected = collected.concat(parsed);
        notes.push(new URL(src.url).hostname + ": " + parsed.length);
      } else {
        notes.push(new URL(src.url).hostname + ": none parsed");
      }
    } catch (e) {
      notes.push(new URL(src.url).hostname + ": " + String((e && e.message) || e).slice(0, 60));
    }
  }

  // Known-good hosts go first: they are the ones actually observed working from
  // a real browser, and the directory's order says nothing about reachability.
  const relays = normalise(FALLBACK.concat(collected));

  return new Response(
    JSON.stringify({ relays, count: relays.length, sources: notes, fresh: collected.length > 0 }),
    { status: 200, headers }
  );
};
