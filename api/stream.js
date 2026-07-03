// Serverless proxy for the live m3u8 playlist.
//
// Why this exists: the upstream (no.gendigi.net) only serves the stream to
// requests carrying a specific Referer/User-Agent. Browsers will not let
// client-side JS (hls.js's XHR/fetch) set a custom Referer header, and the
// browser's *own* referrer behavior for cross-origin requests varies by
// browser/OS/network — which is exactly why it loaded inconsistently
// (worked when pasted directly into a new tab, not when fetched by the app).
//
// Fetching it here, server-side, removes that variability completely: we
// control the outgoing headers ourselves, every time, regardless of the
// visitor's browser or IP.

const DEFAULT_TARGET = "https://no.gendigi.net/origin-proxy/chunklist.m3u8";
const UPSTREAM_REFERER = "https://gen.com.py/";
const UPSTREAM_USER_AGENT = "Mozilla/5.0";

function rewritePlaylist(text, baseUrl) {
  const base = new URL(baseUrl);
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      // Leave blank lines and #EXT tags untouched (except URI= attrs, handled below).
      if (!trimmed) return line;

      if (trimmed.startsWith("#")) {
        // Some tags (e.g. #EXT-X-KEY, #EXT-X-MAP) carry a URI="..." attribute
        // that also needs to be rewritten so key/init-segment fetches go
        // through the proxy too.
        return line.replace(/URI="([^"]+)"/, (_match, uri) => {
          try {
            const abs = new URL(uri, base).toString();
            return `URI="/api/segment?url=${encodeURIComponent(abs)}"`;
          } catch {
            return _match;
          }
        });
      }

      // A plain URI line: sub-playlist (variant) or media segment.
      try {
        const abs = new URL(trimmed, base).toString();
        return `/api/segment?url=${encodeURIComponent(abs)}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

export default async function handler(req, res) {
  const target =
    typeof req.query?.url === "string" && req.query.url
      ? req.query.url
      : DEFAULT_TARGET;

  try {
    const upstream = await fetch(target, {
      headers: {
        Referer: UPSTREAM_REFERER,
        "User-Agent": UPSTREAM_USER_AGENT,
      },
      redirect: "follow",
    });

    if (!upstream.ok) {
      res.status(upstream.status).send(`Upstream error: ${upstream.status}`);
      return;
    }

    const text = await upstream.text();
    const rewritten = rewritePlaylist(text, target);

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).send(rewritten);
  } catch (err) {
    res.status(502).send("Proxy error");
  }
}
