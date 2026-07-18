/**
 * Eclipse Amazon Music Addon - Cloudflare Worker
 * Proxies AmineSoukara/amazon-music (Unofficial Amazon Music API)
 * Serves a landing page + manifest generator, plus the addon API routes Eclipse calls.
 *
 * Required config:
 *  - AMAZON_API_BASE   -> set in wrangler.toml [vars]
 *  - AMAZON_AUTH_TOKEN -> set via `wrangler secret put AMAZON_AUTH_TOKEN` (server-side default; users can also pass their own token in the manifest URL)
 */

const QUALITY_FALLBACK_ORDER = ["Normal", "Medium", "Low"]; // non-DRM (OPUS) fallback chain
const DRM_QUALITIES = ["High", "Master", "Max"]; // FLAC tiers likely Widevine-wrapped

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
  });
}

async function amazonFetch(env, path, opts = {}, tokenOverride) {
  const url = `${env.AMAZON_API_BASE}${path}`;
  const token = tokenOverride || env.AMAZON_AUTH_TOKEN;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Amazon API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function cached(env, key, ttlSeconds, fn) {
  if (env.CACHE) {
    const hit = await env.CACHE.get(key);
    if (hit) return JSON.parse(hit);
  }
  const result = await fn();
  if (env.CACHE) {
    await env.CACHE.put(key, JSON.stringify(result), { expirationTtl: ttlSeconds });
  }
  return result;
}

async function handleSearch(env, query, type, token) {
  const key = `search:${type}:${query}`;
  return cached(env, key, 300, () =>
    amazonFetch(env, `/search?query=${encodeURIComponent(query)}&type=${type}`, {}, token)
  );
}

async function handleTrack(env, id, token) {
  return cached(env, `track:${id}`, 3600, () => amazonFetch(env, `/track?id=${id}`, {}, token));
}

async function handleAlbum(env, id, token) {
  return cached(env, `album:${id}`, 3600, () => amazonFetch(env, `/album?id=${id}`, {}, token));
}

async function handleArtist(env, id, token) {
  return cached(env, `artist:${id}`, 3600, () => amazonFetch(env, `/artist?id=${id}`, {}, token));
}

async function handlePlaylist(env, id, token) {
  return amazonFetch(env, `/playlist?id=${id}`, {}, token);
}

async function handleLyrics(env, id, token) {
  return amazonFetch(env, `/lyrics?id=${id}`, {}, token);
}

async function handleStream(env, id, requestedQuality, allowDrm, token) {
  const data = await amazonFetch(env, `/stream_urls?id=${id}`, {}, token);
  const streams = data.streams || data.stream_urls || data;

  let quality = requestedQuality || "Normal";
  if (DRM_QUALITIES.includes(quality) && !allowDrm) quality = "Normal";

  let entry = streams[quality];
  if (!entry) {
    for (const q of QUALITY_FALLBACK_ORDER) {
      if (streams[q]) { entry = streams[q]; quality = q; break; }
    }
  }
  if (!entry) throw new Error("No playable stream found for track");

  const result = { quality, url: entry.url || entry, drm: DRM_QUALITIES.includes(quality) };

  if (result.drm && entry.pssh) {
    const keyRes = await amazonFetch(env, "/widevine_key", {
      method: "POST",
      body: JSON.stringify({ pssh: entry.pssh }),
    }, token);
    result.widevineKey = keyRes.key || keyRes;
  }
  return result;
}

// ---- Eclipse manifest ----
function buildManifest(baseUrl, token) {
  return {
    id: "com.eclipse.addon.amazonmusic",
    version: "1.0.0",
    name: "Amazon Music",
    description: "Search and stream Amazon Music (up to 24-bit/192kHz FLAC) inside Eclipse, powered by a premium Amazon Music account.",
    logo: `${baseUrl}/logo.png`,
    types: ["music"],
    resources: ["search", "track", "album", "artist", "playlist", "lyrics", "stream"],
    endpoint: baseUrl,
    behaviorHints: { configurable: true, configurationRequired: !token },
    config: token ? { token } : undefined,
  };
}

// ---- Landing page ----
function landingPage(originUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Amazon Music Addon for Eclipse</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(circle at top, #1a1a2e, #0d0d17 70%);
    color: #f2f2f2; display: flex; justify-content: center; padding: 60px 20px; min-height: 100vh;
  }
  .card { max-width: 640px; width: 100%; }
  h1 { font-size: 2rem; margin-bottom: 4px; background: linear-gradient(90deg,#ff9900,#ffd580); -webkit-background-clip: text; background-clip: text; color: transparent; }
  p.sub { color: #b3b3c6; margin-top: 0; margin-bottom: 32px; line-height: 1.5; }
  .box { background: #17171f; border: 1px solid #2a2a3a; border-radius: 12px; padding: 24px; margin-bottom: 20px; }
  label { display: block; font-size: 0.85rem; color: #b3b3c6; margin-bottom: 6px; }
  input[type=text] { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #2a2a3a; background: #0d0d17; color: #f2f2f2; font-size: 0.95rem; box-sizing: border-box; }
  button { margin-top: 14px; padding: 10px 18px; border: none; border-radius: 8px; background: #ff9900; color: #101018; font-weight: 600; cursor: pointer; font-size: 0.95rem; }
  button:hover { background: #ffb84d; }
  .result { margin-top: 16px; display: none; }
  .result.show { display: block; }
  .manifest-url { word-break: break-all; background: #0d0d17; border: 1px solid #2a2a3a; border-radius: 8px; padding: 10px 12px; font-family: monospace; font-size: 0.85rem; color: #ffd580; }
  ul { line-height: 1.7; color: #d0d0dc; }
  .badge { display: inline-block; background: #2a2a3a; color: #ffd580; border-radius: 6px; padding: 2px 8px; font-size: 0.75rem; margin-right: 6px; }
  footer { color: #666; font-size: 0.8rem; margin-top: 30px; text-align: center; }
  a { color: #ffb84d; }
</style>
</head>
<body>
<div class="card">
  <h1>Amazon Music Addon</h1>
  <p class="sub">An Eclipse addon backed by the community <a href="https://github.com/AmineSoukara/amazon-music" target="_blank">amazon-music</a> API, streaming up to 24-bit / 192kHz FLAC with your premium Amazon Music account.</p>

  <div class="box">
    <span class="badge">Search</span><span class="badge">Track</span><span class="badge">Album</span><span class="badge">Artist</span><span class="badge">Playlist</span><span class="badge">Lyrics</span><span class="badge">Stream</span>
    <ul style="margin-top:16px;">
      <li>Quality tiers from Low (48kbps OPUS) up to Max (24-bit/192kHz FLAC)</li>
      <li>Non-DRM tiers stream directly; FLAC tiers require Widevine-capable playback</li>
      <li>Requires a premium Amazon Music auth token (generated via the source repo)</li>
    </ul>
  </div>

  <div class="box">
    <label for="token">Amazon Music auth token</label>
    <input type="text" id="token" placeholder="Paste your token here (optional if server default is configured)">
    <button onclick="generate()">Generate Manifest URL</button>
    <div class="result" id="result">
      <label>Your Eclipse manifest URL</label>
      <div class="manifest-url" id="manifestUrl"></div>
      <button style="margin-top:10px;" onclick="copyUrl()">Copy</button>
    </div>
  </div>

  <footer>Not affiliated with Amazon. Unofficial API usage may break without notice.</footer>
</div>

<script>
  const origin = "${originUrl}";
  function generate() {
    const token = document.getElementById('token').value.trim();
    const url = token
      ? origin + "/manifest.json?token=" + encodeURIComponent(token)
      : origin + "/manifest.json";
    document.getElementById('manifestUrl').textContent = url;
    document.getElementById('result').classList.add('show');
  }
  function copyUrl() {
    navigator.clipboard.writeText(document.getElementById('manifestUrl').textContent);
  }
</script>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    const origin = `${url.protocol}//${url.host}`;
    const tokenParam = searchParams.get("token") || undefined;

    try {
      if (pathname === "/") {
        return html(landingPage(origin));
      }

      if (pathname === "/manifest.json") {
        return json(buildManifest(origin, tokenParam));
      }

      if (pathname === "/search") {
        const q = searchParams.get("query");
        const type = searchParams.get("type") || "track";
        if (!q) return json({ error: "Missing query param 'query'" }, 400);
        return json(await handleSearch(env, q, type, tokenParam));
      }

      if (pathname === "/track") {
        const id = searchParams.get("id");
        if (!id) return json({ error: "Missing 'id'" }, 400);
        return json(await handleTrack(env, id, tokenParam));
      }

      if (pathname === "/album") {
        const id = searchParams.get("id");
        if (!id) return json({ error: "Missing 'id'" }, 400);
        return json(await handleAlbum(env, id, tokenParam));
      }

      if (pathname === "/artist") {
        const id = searchParams.get("id");
        if (!id) return json({ error: "Missing 'id'" }, 400);
        return json(await handleArtist(env, id, tokenParam));
      }

      if (pathname === "/playlist") {
        const id = searchParams.get("id");
        if (!id) return json({ error: "Missing 'id'" }, 400);
        return json(await handlePlaylist(env, id, tokenParam));
      }

      if (pathname === "/lyrics") {
        const id = searchParams.get("id");
        if (!id) return json({ error: "Missing 'id'" }, 400);
        return json(await handleLyrics(env, id, tokenParam));
      }

      if (pathname === "/stream") {
        const id = searchParams.get("id");
        const quality = searchParams.get("quality");
        const allowDrm = searchParams.get("allowDrm") === "1";
        if (!id) return json({ error: "Missing 'id'" }, 400);
        return json(await handleStream(env, id, quality, allowDrm, tokenParam));
      }

      return json({
        error: "Not found",
        availableRoutes: [
          "/", "/manifest.json?token=",
          "/search?query=&type=", "/track?id=", "/album?id=",
          "/artist?id=", "/playlist?id=", "/lyrics?id=",
          "/stream?id=&quality=&allowDrm="
        ],
      }, 404);

    } catch (err) {
      return json({ error: err.message }, 502);
    }
  },
};
