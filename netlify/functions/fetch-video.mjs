// netlify/functions/fetch-video.mjs
//
// Server-side proxy that fetches a video from a social-media link and streams
// the raw file bytes back to the browser. This exists because YouTube,
// TikTok, Instagram, Facebook and Twitter/X all block direct cross-origin
// fetches from a browser (CORS) — there is no client-side fix for that, the
// fetch has to happen from a server. This function is that server.
//
// Called by index.html as: /.netlify/functions/fetch-video?url=<encoded link>
//
// YouTube note (why there is no ytdl-core here any more):
// ytdl-core's getInfo() always loads the plain youtube.com/watch HTML page
// first, and that page is exactly what YouTube bot-blocks from datacenter IPs
// like Netlify's — it answers LOGIN_REQUIRED / "Sign in to confirm you're not
// a bot" before any of the mobile clients are even tried. So we skip that page
// and call YouTube's innertube player API directly. Dropping the dependency
// also removes the bundler fragility that made this whole function 404.
//
// Which innertube client, and why ANDROID_VR — measured 2026-09-05 from a
// datacenter IP against real videos, since this is exactly the situation
// Netlify is in:
//   IOS, ANDROID .................. HTTP 400 FAILED_PRECONDITION (dead)
//   TVHTML5_SIMPLY_EMBEDDED ....... "YouTube is no longer supported in this app"
//   WEB_EMBEDDED_PLAYER ........... "This video is unavailable"
//   WEB, MWEB, TVHTML5, *_MUSIC,
//   WEB_CREATOR, ANDROID_CREATOR .. LOGIN_REQUIRED / "Please sign in"
//   ANDROID_VR .................... the only one that ever returns OK with a
//                                   direct, unciphered progressive URL
// ANDROID_VR is not a silver bullet — it succeeded on 1 of 5 test videos, the
// rest still answered LOGIN_REQUIRED, and that result was stable across
// repeats (per-video, not random). Anonymous server-side YouTube downloading
// is largely closed; this gets the videos that are still gettable and gives an
// honest, actionable error for the rest.

import dns from "node:dns/promises";
import net from "node:net";

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// ---------- SSRF guard ----------
// This function fetches whatever URL it's told to and streams the response
// straight back to the caller. Without a check like this, the "unrecognized
// platform" fallback below turns it into an open proxy: anyone on the
// internet (no auth on this endpoint) could point it at internal services,
// cloud metadata endpoints, or localhost, and read the response through us.
// Every outbound fetch of a URL that traces back to user input or a
// third-party API response goes through this first.
function isPrivateOrReservedIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata (169.254.169.254)
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    return false;
  }
  if (type === 6) {
    const low = ip.toLowerCase();
    if (low === "::1") return true; // loopback
    if (low.startsWith("fe80:") || low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) return true; // link-local
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // unique local
    if (low.startsWith("::ffff:")) return isPrivateOrReservedIp(low.slice(7)); // IPv4-mapped
    return false;
  }
  return true; // not a parseable IP literal at all — treat as unsafe
}

async function assertPublicHttpUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("קישור לא תקין");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("מותרים רק קישורי http/https");
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 [] brackets
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("קישור לא מורשה");
  }
  // literal IP in the URL itself
  if (net.isIP(host) && isPrivateOrReservedIp(host)) {
    throw new Error("קישור לא מורשה");
  }
  // resolve the hostname and block it if ANY resolved address is private/reserved —
  // closes the DNS-rebinding gap where the hostname itself looks public
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("לא ניתן היה לפענח את הכתובת");
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateOrReservedIp(a.address))) {
    throw new Error("קישור לא מורשה");
  }
  return u;
}

// Follows redirects by hand, re-running the SSRF check on every hop. Plain
// redirect:"follow" would let hop 2 land on a private address that hop 1's
// check never saw; redirect:"error" is safe but too strict — googlevideo and
// most CDNs legitimately redirect once or twice before serving the bytes.
async function safeFetchFollowing(startUrl, headers, maxHops = 4) {
  let current = startUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    const safeUrl = await assertPublicHttpUrl(current);
    const resp = await fetch(safeUrl, { redirect: "manual", headers });
    const location = resp.headers.get("location");
    if (resp.status >= 300 && resp.status < 400 && location) {
      current = new URL(location, safeUrl).toString();
      continue;
    }
    return resp;
  }
  throw new Error("יותר מדי הפניות (redirects) בדרך לקובץ");
}

// HTTP header values are Latin-1 only. A TikTok title in Hebrew (or any
// non-Latin script) put straight into Content-Disposition makes building the
// Response throw — "character at index N has a value of 1497" — after the video
// has already been fetched, so a completely successful download died on its
// last line. RFC 6266 covers exactly this: an ASCII filename for anything old,
// and filename* carrying the real UTF-8 name for anything modern.
function contentDisposition(name) {
  const safe = String(name || "video.mp4");
  const ascii = safe.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "'").trim() || "video.mp4";
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(safe);
}

function safeName(raw, fallback) {
  let s = (raw || fallback || "video").toString().trim();
  s = s.replace(/[\\/:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").trim();
  return (s || fallback || "video").slice(0, 80);
}

async function fetchText(url, extraHeaders) {
  // Guarded like every other outbound fetch here. The callers currently pass
  // host-checked URLs, but this reads a remote page into our process and the
  // check belongs at the fetch, not in the memory of whoever calls it.
  const safeUrl = await assertPublicHttpUrl(url);
  const r = await fetch(safeUrl, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...extraHeaders },
  });
  if (!r.ok) throw new Error("http " + r.status + " בגישה ל-" + url);
  return await r.text();
}

// ---------- YouTube (innertube, no third-party library) ----------
const YT_CLIENTS = {
  ANDROID_VR: {
    clientName: "ANDROID_VR",
    clientVersion: "1.60.19",
    clientNumber: "28",
    deviceMake: "Oculus",
    deviceModel: "Quest 3",
    androidSdkVersion: 32,
    platform: "MOBILE",
    osName: "Android",
    osVersion: "12L",
    userAgent:
      "com.google.android.apps.youtube.vr.oculus/1.60.19 " +
      "(Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
  },
};

// A client playback nonce — YouTube rejects player requests without one.
function clientPlaybackNonce(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function youtubeVideoId(u) {
  const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
  if (host === "youtu.be") {
    const id = u.pathname.split("/").filter(Boolean)[0];
    return id || null;
  }
  const v = u.searchParams.get("v");
  if (v) return v;
  // /shorts/<id>, /embed/<id>, /live/<id>, /v/<id>
  const m = u.pathname.match(/\/(?:shorts|embed|live|v)\/([^/?#]+)/);
  return m ? m[1] : null;
}

async function innertubePlayer(videoId, clientKey) {
  const c = YT_CLIENTS[clientKey];
  const payload = {
    videoId,
    cpn: clientPlaybackNonce(16),
    contentCheckOk: true,
    racyCheckOk: true,
    context: {
      client: {
        clientName: c.clientName,
        clientVersion: c.clientVersion,
        ...(c.deviceMake ? { deviceMake: c.deviceMake } : {}),
        ...(c.deviceModel ? { deviceModel: c.deviceModel } : {}),
        ...(c.androidSdkVersion ? { androidSdkVersion: c.androidSdkVersion } : {}),
        platform: c.platform,
        osName: c.osName,
        osVersion: c.osVersion,
        hl: "en",
        gl: "US",
        utcOffsetMinutes: 0,
      },
      request: { internalExperimentFlags: [], useSsl: true },
      user: { lockedSafetyMode: false },
    },
  };

  const r = await fetch("https://youtubei.googleapis.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": c.userAgent,
      "X-Goog-Api-Format-Version": "2",
      "X-YouTube-Client-Name": c.clientNumber,
      "X-YouTube-Client-Version": c.clientVersion,
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error("youtube api http " + r.status);
  return await r.json();
}

// Progressive formats (audio+video in one file) are the only ones usable here —
// adaptive DASH streams would need muxing, which is way out of scope for a
// detector that just needs the pixels and the metadata.
function pickProgressiveFormat(player) {
  const formats = (player && player.streamingData && player.streamingData.formats) || [];
  const usable = formats.filter((f) => f.url && (f.mimeType || "").startsWith("video/"));
  if (!usable.length) return null;
  // itag 18 = 360p mp4, small and fast to download — good enough for analysis.
  return (
    usable.find((f) => f.itag === 18) ||
    usable.sort((a, b) => (a.contentLength || 0) - (b.contentLength || 0))[0]
  );
}

// YouTube's block message is in English and says "sign in", which reads like
// the user did something wrong. They didn't — YouTube refuses servers, not
// them. Say that plainly, and point at the path that always works.
const YT_BLOCKED_MESSAGE =
  "יוטיוב חוסם הורדה של הסרטון הזה משרתים (זו חסימה שלהם, לא תקלה אצלנו). " +
  'הדרך שתמיד עובדת: להוריד את הסרטון למכשיר ואז להעלות אותו כאן בלשונית "העלאת קובץ".';

async function resolveYouTube(u) {
  const videoId = youtubeVideoId(u);
  if (!videoId) throw new Error("לא הצלחתי לזהות מזהה סרטון בקישור היוטיוב הזה");

  let player;
  try {
    player = await innertubePlayer(videoId, "ANDROID_VR");
  } catch (e) {
    throw new Error("לא הצלחתי לדבר עם יוטיוב (" + ((e && e.message) || e) + ")");
  }

  const status = (player && player.playabilityStatus) || {};
  if (status.status && status.status !== "OK") {
    // LOGIN_REQUIRED is the bot-check; ERROR/UNPLAYABLE usually means the video
    // is genuinely gone, private or region-locked — different message, because
    // for those the upload workaround won't help either.
    if (status.status === "LOGIN_REQUIRED") throw new Error(YT_BLOCKED_MESSAGE);
    throw new Error(
      "יוטיוב מדווח שהסרטון לא זמין" + (status.reason ? " (" + status.reason + ")" : "") +
      " — יתכן שהוא פרטי, נמחק, או מוגבל באזור."
    );
  }

  const format = pickProgressiveFormat(player);
  if (!format) throw new Error(YT_BLOCKED_MESSAGE);

  const title = safeName(player.videoDetails && player.videoDetails.title, "youtube");
  return {
    directUrl: format.url,
    filename: title + ".mp4",
    ua: YT_CLIENTS.ANDROID_VR.userAgent,
  };
}

// ---------- TikTok ----------
// The share sheet hands out vt./vm.tiktok.com shorteners, and those are what
// people actually paste. Passing one straight to the resolver is what made a
// perfectly public video come back as "private or removed": the shortener is
// an opaque redirect, not the post. Expand it to the canonical
// /@user/video/<id> URL first, then resolve that.
const TIKTOK_SHORT_HOSTS = ["vt.tiktok.com", "vm.tiktok.com", "t.tiktok.com"];

function isTikTokShortLink(u) {
  return TIKTOK_SHORT_HOSTS.includes(u.hostname.toLowerCase().replace(/^www\./, ""));
}

function isTikTokHost(u) {
  const h = u.hostname.toLowerCase().replace(/^www\./, "");
  return h === "tiktok.com" || h.endsWith(".tiktok.com");
}

async function expandTikTokShortLink(url) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const parsed = new URL(current);
    if (!isTikTokShortLink(parsed)) break;
    const safeUrl = await assertPublicHttpUrl(current); // every hop re-checked
    const r = await fetch(safeUrl, { redirect: "manual", headers: { "User-Agent": UA } });
    const location = r.headers.get("location");
    if (!location) break;
    current = new URL(location, safeUrl).toString();
  }
  // Where a redirect lands is decided by the far end, not by us, and the
  // result is fetched again downstream (the og:video fallback). A shortener
  // that pointed anywhere but TikTok would turn this into an open redirect
  // into our own outbound fetches, so anything off-platform is discarded and
  // the original URL stands.
  try {
    const final = new URL(current);
    if ((final.protocol === "http:" || final.protocol === "https:") && isTikTokHost(final)) {
      return current;
    }
  } catch {}
  return url;
}

async function resolveTikTok(url) {
  let canonical = url;
  try {
    canonical = await expandTikTokShortLink(url);
  } catch {
    // fall through with the original — the resolver may still cope with it
  }

  const api = "https://www.tikwm.com/api/?url=" + encodeURIComponent(canonical) + "&hd=1";
  const r = await fetch(api, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("tikwm http " + r.status);
  const j = await r.json();
  const d = j && j.data;

  // The resolver offers several copies of the same video (HD, standard,
  // watermarked). Taking only the first and giving up when it 502s throws away
  // two working URLs — they are alternates, not a ranking, and a free service
  // failing on one says nothing about the others.
  const candidates = [];
  for (const key of ["hdplay", "play", "wmplay"]) {
    const v = d && d[key];
    if (typeof v === "string" && /^https?:\/\//i.test(v) && !candidates.includes(v)) {
      candidates.push(v);
    }
  }
  const play = candidates[0];

  if (!play) {
    // Second opinion before giving up: the post's own page carries an og:video
    // for public videos, so a resolver miss isn't proof the post is private.
    try {
      return await resolveByOgVideo(canonical, "טיקטוק", "https://www.tiktok.com/");
    } catch {
      throw new Error(
        "לא הצלחתי לחלץ את הסרטון מטיקטוק" +
        (j && j.msg ? " (" + j.msg + ")" : "") +
        " — יתכן שהפוסט פרטי, הוסר, או מוגבל באזור."
      );
    }
  }

  return {
    directUrl: play,
    candidates,
    filename: safeName(d.title, "tiktok") + ".mp4",
    referer: "https://www.tiktok.com/",
    // Used only if every copy above refuses to serve: read the file straight
    // off the post's own page instead of through the resolver.
    fallback: () => resolveByOgVideo(canonical, "טיקטוק", "https://www.tiktok.com/"),
  };
}

// ---------- Twitter / X ----------
async function resolveTwitter(url) {
  const u = new URL(url);
  const path = u.pathname.replace(/\/$/, "");
  const api = "https://api.vxtwitter.com" + path;
  const r = await fetch(api, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("vxtwitter http " + r.status);
  const j = await r.json();
  const media =
    j &&
    j.media_extended &&
    j.media_extended.find((m) => m.type === "video" || m.type === "gif");
  if (!media || !media.url) throw new Error("לא נמצא סרטון בציוץ הזה");
  return { directUrl: media.url, filename: safeName(j.text, "twitter") + ".mp4" };
}

// ---------- Instagram / Facebook (best-effort, public posts only) ----------
async function resolveByOgVideo(url, platformLabel, referer) {
  const html = await fetchText(url, referer ? { Referer: referer } : undefined);
  const m =
    html.match(/<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/"video_url":"([^"]+)"/);
  if (!m) {
    throw new Error(
      "לא נמצא קישור וידאו ישיר ב-" + platformLabel + " (הפוסט כנראה פרטי או דורש התחברות)"
    );
  }
  const direct = m[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  let title = platformLabel;
  const tm = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (tm) title = tm[1];
  return { directUrl: direct, filename: safeName(title, platformLabel) + ".mp4", referer: referer || url };
}

// ---------- dispatch by platform ----------
async function resolveVideoUrl(targetUrl) {
  let u;
  try {
    u = new URL(targetUrl);
  } catch {
    throw new Error("קישור לא תקין");
  }
  const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");

  if (host === "youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com")) {
    return await resolveYouTube(u);
  }

  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
    return await resolveTikTok(targetUrl);
  }

  if (host === "twitter.com" || host === "x.com") {
    return await resolveTwitter(targetUrl);
  }

  if (host === "instagram.com") {
    return await resolveByOgVideo(targetUrl, "אינסטגרם", "https://www.instagram.com/");
  }

  if (host === "facebook.com" || host === "fb.watch" || host.endsWith(".facebook.com")) {
    return await resolveByOgVideo(targetUrl, "פייסבוק", "https://www.facebook.com/");
  }

  // Fallback: not a platform we special-cased — try it as a direct file link.
  return { directUrl: targetUrl, filename: safeName(u.pathname.split("/").pop(), "file") };
}

export default async (req) => {
  const { searchParams } = new URL(req.url);
  const targetUrl = (searchParams.get("url") || "").trim();
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (!targetUrl) {
    return new Response(JSON.stringify({ error: "חסר קישור" }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  try {
    const resolved = await resolveVideoUrl(targetUrl);

    const attempt = { status: 0, error: null, tried: 0 };

    // Walks the copies of one video and returns the first that actually streams.
    async function firstWorking(urls, source) {
      for (const candidate of urls) {
        if (!candidate) continue;
        attempt.tried++;

        // A Referer only makes sense to the site it names. Some of these URLs
        // are served by a resolver's own host rather than the platform, and
        // handing that host a foreign Referer is at best noise and at worst the
        // reason it refuses.
        let sameFamily = false;
        try {
          const target = new URL(candidate).hostname.toLowerCase();
          const refHost = source.referer ? new URL(source.referer).hostname.toLowerCase() : "";
          const root = (h) => h.split(".").slice(-2).join(".");
          sameFamily = !!refHost && root(target) === root(refHost);
        } catch {}

        const headers = {
          "User-Agent": source.ua || UA,
          ...(source.referer && sameFamily ? { Referer: source.referer } : {}),
        };

        // One retry per copy: 5xx is usually a moment of load, not a verdict.
        // 4xx is a verdict — move on.
        for (let i = 0; i < 2; i++) {
          try {
            const r = await safeFetchFollowing(candidate, headers);
            if (r.ok && r.body) return r;
            attempt.status = r.status;
            if (r.status < 500) break;
          } catch (e) {
            attempt.error = e;
            break;
          }
        }
      }
      return null;
    }

    const listOf = (r) => (r.candidates && r.candidates.length ? r.candidates : [r.directUrl]);

    let upstream = await firstWorking(listOf(resolved), resolved);

    // A third-party resolver handing back a URL that then refuses to serve is
    // its failure, not the video's — and the platform's own page is a separate
    // source for the same file. Previously that fallback only ran when the
    // resolver found nothing at all, so a dead URL ended the attempt with a
    // perfectly downloadable video one step away.
    if (!upstream && typeof resolved.fallback === "function") {
      try {
        const alt = await resolved.fallback();
        if (alt) upstream = await firstWorking(listOf(alt), alt);
        if (upstream) resolved.filename = alt.filename || resolved.filename;
      } catch (e) {
        if (!attempt.error) attempt.error = e;
      }
    }

    if (!upstream) {
      // A real HTTP refusal is the more useful thing to report, so it wins over
      // whatever the last source happened to throw on its way out.
      if (attempt.status) {
        throw new Error(
          "השרת המקורי סירב לספק את הקובץ (סטטוס " + attempt.status + ")" +
          (attempt.tried > 1 ? " — ניסיתי " + attempt.tried + " מקורות שונים לאותו סרטון." : "")
        );
      }
      if (attempt.error) throw attempt.error;
      throw new Error("לא הצלחתי להוריד את הקובץ מאף אחד מהמקורות.");
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "video/mp4",
        "Content-Disposition": contentDisposition(resolved.filename),
        ...cors,
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err && err.message) || err) }), {
      status: 502,
      headers: { "content-type": "application/json", ...cors },
    });
  }
};
