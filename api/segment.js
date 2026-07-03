// Proxies individual .ts segments, variant sub-playlists, and encryption
// keys referenced from the rewritten master playlist (see api/stream.js),
// always attaching the same Referer/User-Agent the upstream requires.

const UPSTREAM_REFERER = "https://gen.com.py/";
const UPSTREAM_USER_AGENT = "Mozilla/5.0";

function rewritePlaylist(text, baseUrl) {
  const base = new URL(baseUrl);
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/, (_match, uri) => {
          try {
            const abs = new URL(uri, base).toString();
            return `URI="/api/segment?url=${encodeURIComponent(abs)}"`;
          } catch {
            return _match;
          }
        });
      }
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
  const target = req.query?.url;
  if (typeof target !== "string" || !target) {
    res.status(400).send("Missing url");
    return;
  }

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

    const contentType = upstream.headers.get("content-type") || "";
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.setHeader("Access-Control-Allow-Origin", "*");

    const isPlaylist =
      contentType.includes("mpegurl") || target.endsWith(".m3u8");

    if (isPlaylist) {
      const text = await upstream.text();
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.status(200).send(rewritePlaylist(text, target));
      return;
    }

    res.setHeader("Content-Type", contentType || "application/octet-stream");
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.status(200).send(buffer);
  } catch (err) {
    res.status(502).send("Proxy error");
  }
}
