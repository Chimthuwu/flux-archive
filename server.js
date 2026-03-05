import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import mime from "mime-types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const ARCHIVE_ROOT = path.join(__dirname, "archive_data");
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

app.use(express.static(PUBLIC_DIR));
app.use(express.json({ limit: "1mb" }));

function safeId(id) {
  if (!id) return null;
  if (id.includes("..") || id.startsWith("/") || id.startsWith("\\") || id.includes("\0")) return null;
  return id.replaceAll("\\", "/");
}

function walkDir(dir, base = dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkDir(full, base, out);
    } else {
      const stat = fs.statSync(full);
      const relPath = path.relative(base, full).replaceAll("\\", "/");
      const ext = path.extname(ent.name).toLowerCase();
      const guessed = mime.lookup(ext) || "application/octet-stream";
      out.push({
        id: relPath,
        relPath,
        name: ent.name,
        size: stat.size,
        mtime: stat.mtimeMs,
        type: guessed,
        category: relPath.split("/")[0]?.toLowerCase() || ""
      });
    }
  }
  return out;
}

function buildTreeFromPaths(paths) {
  const root = {};
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i];
      const isFile = i === parts.length - 1;
      node[key] ??= isFile ? null : {};
      if (!isFile) node = node[key];
    }
  }
  return root;
}

let FILE_INDEX = [];
function buildIndex() {
  if (!fs.existsSync(ARCHIVE_ROOT)) {
    console.warn("ARCHIVE_ROOT missing:", ARCHIVE_ROOT);
    FILE_INDEX = [];
    return;
  }
  FILE_INDEX = walkDir(ARCHIVE_ROOT);
  console.log("Indexed files:", FILE_INDEX.length);
}
buildIndex();

app.get("/api/reindex", (req, res) => {
  buildIndex();
  res.json({ ok: true, count: FILE_INDEX.length });
});

app.get("/api/tree", (req, res) => {
  // Build a directory tree from relPaths (fast enough for a few 10k files; optimize later if huge)
  const tree = buildTreeFromPaths(FILE_INDEX.map(f => f.relPath));
  res.json({ ok: true, tree });
});

app.get("/api/search", (req, res) => {
  const q = String(req.query.q || "").toLowerCase().trim();
  const category = String(req.query.category || "").toLowerCase().trim();

  if (!q) return res.json({ results: [] });

  let results = FILE_INDEX.filter(f =>
    f.name.toLowerCase().includes(q) || f.relPath.toLowerCase().includes(q)
  );

  if (category) results = results.filter(f => f.category === category);

  results.sort((a, b) => b.mtime - a.mtime);
  res.json({ results: results.slice(0, 100) });
});

// “AI-ish” natural language router (no external LLM required)
app.post("/api/ai", (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  const p = prompt.toLowerCase();

  // Category inference from words
  const catWords = [
    ["audio", ["sample", "samples", "preset", "presets", "vst", "plugin", "plugins", "drum", "sfx"]],
    ["music", ["track", "tracks", "album", "albums", "artist", "genre", "mix"]],
    ["video", ["film", "movie", "tv", "television", "anime", "animation", "episode"]],
    ["gaming", ["rom", "roms", "mod", "mods", "emulation", "emu", "game", "games", "snes", "ps2"]],
    ["literature", ["book", "books", "manga", "lyrics", "pdf", "epub"]],
    ["misc", ["misc", "random"]]
  ];

  let category = "";
  for (const [cat, words] of catWords) {
    if (words.some(w => p.includes(w))) { category = cat; break; }
  }

  // Extract a “query-ish” chunk (very simple)
  // Examples:
  // "find jungle breakbeats" => query "jungle breakbeats"
  // "show 90s anime" => "90s anime"
  // "play aphex twin" => "aphex twin"
  const verbStripped = p
    .replace(/^(find|show|locate|search|open|play|queue|load)\s+/, "")
    .trim();

  const q = verbStripped || p;

  let results = FILE_INDEX.filter(f =>
    f.name.toLowerCase().includes(q) || f.relPath.toLowerCase().includes(q)
  );

  if (category) results = results.filter(f => f.category === category);

  // Prefer audio if prompt says play
  const wantsPlay = /^play\s+/.test(p) || p.includes("play ");
  if (wantsPlay) results.sort((a, b) => {
    const aa = a.type.startsWith("audio/") ? 0 : 1;
    const bb = b.type.startsWith("audio/") ? 0 : 1;
    return aa - bb || (b.mtime - a.mtime);
  });
  else results.sort((a, b) => b.mtime - a.mtime);

  res.json({
    ok: true,
    inferred: { category, query: q, wantsPlay },
    results: results.slice(0, 100)
  });
});

// Stream file safely with Range support
app.get("/api/file", (req, res) => {
  const id = safeId(String(req.query.id || ""));
  if (!id) return res.status(400).send("Bad id");

  const full = path.join(ARCHIVE_ROOT, id);
  if (!full.startsWith(ARCHIVE_ROOT)) return res.status(400).send("Bad path");
  if (!fs.existsSync(full)) return res.status(404).send("Not found");

  const stat = fs.statSync(full);
  if (!stat.isFile()) return res.status(404).send("Not a file");

  const contentType = mime.lookup(full) || "application/octet-stream";
  res.setHeader("Content-Type", contentType);

  const range = req.headers.range;
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize
    });

    fs.createReadStream(full, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", stat.size);
    fs.createReadStream(full).pipe(res);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Archive server running on port", PORT));