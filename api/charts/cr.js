
/*
 * SHUNEL — API: Spotify Daily Top 50 Costa Rica
 *
 * Endpoint: GET /api/charts/cr
 * Fuente: https://kworb.net/spotify/country/cr_daily.html
 *
 * Vercel Node.js Function.
 * No requiere dependencias externas.
 */

const CHART_URL =
  "https://kworb.net/spotify/country/cr_daily.html";

const REQUEST_TIMEOUT_MS = 10000;
const MAX_HTML_SIZE = 5 * 1024 * 1024;

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => {
      const number = Number(code);

      return Number.isFinite(number)
        ? String.fromCodePoint(number)
        : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const number = parseInt(code, 16);

      return Number.isFinite(number)
        ? String.fromCodePoint(number)
        : "";
    });
}

function stripTags(value) {
  return decodeEntities(
    String(value || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function getCells(rowHtml) {
  const cells = [];

  const regex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;

  let match;

  while ((match = regex.exec(rowHtml)) !== null) {
    cells.push(match[1]);
  }

  return cells;
}

function getAnchors(cellHtml) {
  const anchors = [];

  const regex = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while ((match = regex.exec(cellHtml)) !== null) {
    const text = stripTags(match[1]);

    if (text) {
      anchors.push(text);
    }
  }

  return anchors;
}

function parseInteger(value) {
  const normalized = String(value || "")
    .replace(/[^\d-]/g, "");

  if (!normalized) return null;

  const number = Number(normalized);

  return Number.isSafeInteger(number)
    ? number
    : null;
}

function parseMovement(value) {
  const text = stripTags(value).toUpperCase();

  if (text.includes("NEW")) {
    return {
      movement: null,
      movementType: "new"
    };
  }

  if (text.includes("RE")) {
    return {
      movement: null,
      movementType: "reentry"
    };
  }

  if (text === "=" || !text) {
    return {
      movement: 0,
      movementType: "stable"
    };
  }

  const number = parseInteger(text);

  if (number === null) {
    return {
      movement: 0,
      movementType: "stable"
    };
  }

  return {
    movement: number,
    movementType: number > 0
      ? "up"
      : number < 0
        ? "down"
        : "stable"
  };
}

function parseDate(html) {
  const match = html.match(
    /Spotify\s+Daily\s+Chart\s*-\s*Costa\s+Rica\s*-\s*(\d{4})\/(\d{2})\/(\d{2})/i
  );

  if (!match) return null;

  return `${match[3]}/${match[2]}/${match[1]}`;
}

function parseChart(html) {
  const rows = [];

  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;

  let match;

  while ((match = rowRegex.exec(html)) !== null) {
    const cells = getCells(match[1]);

    if (cells.length < 7) continue;

    const rank = parseInteger(
      stripTags(cells[0])
    );

    if (
      rank === null ||
      rank < 1 ||
      rank > 200
    ) {
      continue;
    }

    const artistTitleCell = cells[2];

    const anchors = getAnchors(
      artistTitleCell
    );

    let artist = anchors[0] || "";
    let title = anchors[1] || "";

    if (!artist || !title) {
      const fallback = stripTags(
        artistTitleCell
      );

      const separator = fallback.indexOf(" - ");

      if (separator > 0) {
        artist ||= fallback
          .slice(0, separator)
          .trim();

        title ||= fallback
          .slice(separator + 3)
          .trim();
      }
    }

    if (!artist || !title) continue;

    const movement = parseMovement(cells[1]);

    const streams = parseInteger(
      stripTags(cells[6])
    );

    rows.push({
      rank,
      artist,
      title,
      streams,
      movement: movement.movement,
      movementType: movement.movementType,

      previousPosition:
        movement.movementType === "new"
          ? null
          : movement.movementType === "reentry"
            ? null
            : rank + (movement.movement || 0)
    });
  }

  rows.sort((a, b) => a.rank - b.rank);

  const top50 = rows
    .filter(track => track.rank <= 50)
    .slice(0, 50);

  if (top50.length < 40) {
    throw new Error(
      `La fuente devolvió solo ${top50.length} canciones válidas.`
    );
  }

  return top50;
}

function setHeaders(res) {
  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400"
  );

  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );
}

export default async function handler(req, res) {
  setHeaders(res);

  if (
    req.method !== "GET" &&
    req.method !== "HEAD"
  ) {
    res.setHeader("Allow", "GET, HEAD");

    return res.status(405).json({
      error: "Método no permitido."
    });
  }

  if (req.method === "HEAD") {
    return res.status(200).end();
  }

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(CHART_URL, {
      method: "GET",

      headers: {
        "Accept": "text/html,application/xhtml+xml",

        "User-Agent":
          "Mozilla/5.0 (compatible; ShunelCharts/1.0; +https://shunel.vercel.app)"
      },

      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(
        `La fuente respondió con HTTP ${response.status}.`
      );
    }

    const html = await response.text();

    if (
      !html ||
      html.length > MAX_HTML_SIZE
    ) {
      throw new Error(
        "La respuesta de la fuente está vacía o es demasiado grande."
      );
    }

    const tracks = parseChart(html);

    return res.status(200).json({
      ok: true,
      country: "Costa Rica",
      countryCode: "cr",
      chart: "Spotify Daily Top 50",
      date: parseDate(html),
      updatedAt: new Date().toISOString(),
      count: tracks.length,
      tracks,
      source: CHART_URL
    });

  } catch (error) {
    const timedOut =
      error?.name === "AbortError";

    console.error(
      "[Shunel Charts] Error:",
      error
    );

    return res.status(
      timedOut ? 504 : 502
    ).json({
      ok: false,

      error: timedOut
        ? "La fuente del ranking tardó demasiado en responder."
        : "No se pudo consultar el ranking de Spotify Costa Rica."
    });

  } finally {
    clearTimeout(timeout);
  }
}
