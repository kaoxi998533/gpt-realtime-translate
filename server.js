import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");

if (existsSync(join(__dirname, ".env"))) {
  const envText = await readFile(join(__dirname, ".env"), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const realtimeModel = process.env.REALTIME_MODEL || "gpt-realtime";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const directions = {
  auto: "Detect whether the user spoke Mandarin Chinese or English. Translate Mandarin Chinese to natural English. Translate English to natural Mandarin Chinese.",
  zh_en: "Translate Mandarin Chinese to natural English. If the user speaks English, briefly say that Chinese input is expected.",
  en_zh: "Translate English to natural Mandarin Chinese. If the user speaks Mandarin Chinese, briefly say that English input is expected.",
};

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function createClientSecret(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    json(res, 500, {
      error: "Missing OPENAI_API_KEY. Add it to your shell environment or a local .env loader before starting the server.",
    });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const mode = url.searchParams.get("mode") || "auto";
  const direction = directions[mode] || directions.auto;

  const sessionConfig = {
    expires_after: {
      anchor: "created_at",
      seconds: 600,
    },
    session: {
      type: "realtime",
      model: realtimeModel,
      instructions: [
        "You are a live two-way interpreter.",
        direction,
        "Only output the translation. Do not explain, summarize, answer questions, or add commentary.",
        "Preserve names, numbers, units, tone, and intent. Keep the result concise and spoken naturally.",
      ].join(" "),
      output_modalities: ["audio"],
      audio: {
        input: {
          transcription: {
            model: "gpt-4o-mini-transcribe",
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.78,
            prefix_padding_ms: 250,
            silence_duration_ms: 900,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          voice: "marin",
          speed: 1,
        },
      },
    },
  };

  try {
    const openaiRes = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sessionConfig),
    });

    const text = await openaiRes.text();
    if (!openaiRes.ok) {
      res.writeHead(openaiRes.status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(text);
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(text);
  } catch (error) {
    json(res, 502, { error: `Failed to create realtime client secret: ${error.message}` });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(publicDir, requestedPath));

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    json(res, 404, { error: "Not found" });
    return;
  }

  const body = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url?.startsWith("/api/session")) {
      await createClientSecret(req, res);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res);
      return;
    }

    json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`Realtime translator running at http://${host}:${port}`);
});
