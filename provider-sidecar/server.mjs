// Nautilus provider sidecar
// Runs @movie-web/providers natively (server-side, no CORS limits) and exposes
// stream resolution over localhost HTTP so the FastAPI backend can call it.
//
//   GET /health
//   GET /resolve?type=movie&tmdbId=27205&title=Inception&year=2010&imdbId=tt1375666
//   GET /resolve?type=show&tmdbId=1399&title=Game+of+Thrones&year=2011&season=1&episode=1
//   GET /hunt?...        -> run every source, return all working streams
//
// Node 24 has global fetch, so no node-fetch dependency is needed.

import http from "node:http";
import {
  makeProviders,
  makeStandardFetcher,
  makeSimpleProxyFetcher,
  targets,
} from "@movie-web/providers";

const PORT = Number(process.env.SIDECAR_PORT || 8788);
const HOST = process.env.SIDECAR_HOST || "127.0.0.1";

// Optional CORS proxy (movie-web simple-proxy). Some sources need it; native
// fetcher covers the rest. Set PROXY_URL to enable proxied sources.
const PROXY_URL = process.env.PROXY_URL || null;

// Node's global fetch (undici) rejects the foreign AbortSignal the provider lib
// attaches ("Expected signal to be an instance of AbortSignal"), which kills most
// sources before they make a request. Strip the signal so requests actually fire.
const safeFetch = (input, init = {}) => {
  const { signal, ...rest } = init || {};
  return fetch(input, rest);
};

const providers = makeProviders({
  fetcher: makeStandardFetcher(safeFetch),
  proxiedFetcher: PROXY_URL
    ? makeSimpleProxyFetcher(PROXY_URL, safeFetch)
    : undefined,
  target: targets.NATIVE, // server-side: no CORS restrictions
  consistentIpForRequests: true,
});

function buildMedia(q) {
  const type = q.type === "show" || q.type === "tv" ? "show" : "movie";
  const media = {
    type,
    title: q.title || "",
    releaseYear: q.year ? Number(q.year) : undefined,
    tmdbId: q.tmdbId ? String(q.tmdbId) : undefined,
    imdbId: q.imdbId || undefined,
  };
  if (type === "show") {
    media.season = {
      number: Number(q.season || 1),
      tmdbId: q.seasonTmdbId || undefined,
    };
    media.episode = {
      number: Number(q.episode || 1),
      tmdbId: q.episodeTmdbId || undefined,
    };
  }
  return media;
}

function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (url.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      lib: "@movie-web/providers",
      sources: providers.listSources().length,
      embeds: providers.listEmbeds().length,
      proxied: Boolean(PROXY_URL),
    });
  }

  if (url.pathname === "/sources") {
    return sendJson(res, 200, {
      sources: providers.listSources(),
      embeds: providers.listEmbeds(),
    });
  }

  // Best single stream (highest-rank working source) — mirrors FastAPI /stream
  if (url.pathname === "/resolve") {
    const media = buildMedia(Object.fromEntries(url.searchParams));
    try {
      const out = await providers.runAll({ media });
      if (!out || !out.stream) {
        return sendJson(res, 200, { ok: false, error: "no streams", stream: null });
      }
      return sendJson(res, 200, {
        ok: true,
        sourceId: out.sourceId,
        embedId: out.embedId,
        stream: out.stream,
      });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e?.message || e) });
    }
  }

  // Every working stream from every applicable source — mirrors FastAPI /stream/hunt
  if (url.pathname === "/hunt") {
    const media = buildMedia(Object.fromEntries(url.searchParams));
    const found = [];
    const sources = providers
      .listSources()
      .filter((s) => s.mediaTypes?.includes(media.type));
    await Promise.all(
      sources.map(async (s) => {
        try {
          const srcOut = await providers.runSourceScraper({ id: s.id, media });
          if (srcOut?.stream?.length) {
            for (const stream of srcOut.stream) {
              found.push({ sourceId: s.id, embedId: null, stream });
            }
          }
          // Resolve any embeds this source returned
          for (const emb of srcOut?.embeds || []) {
            try {
              const embOut = await providers.runEmbedScraper({
                id: emb.embedId,
                url: emb.url,
              });
              if (embOut?.stream?.length) {
                for (const stream of embOut.stream) {
                  found.push({ sourceId: s.id, embedId: emb.embedId, stream });
                }
              }
            } catch {
              /* embed failed; skip */
            }
          }
        } catch {
          /* source failed; skip */
        }
      }),
    );
    return sendJson(res, 200, { ok: true, count: found.length, streams: found });
  }

  return sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(
    `[sidecar] @movie-web/providers on http://${HOST}:${PORT} | sources=${providers
      .listSources()
      .length} embeds=${providers.listEmbeds().length} proxied=${Boolean(PROXY_URL)}`,
  );
});
