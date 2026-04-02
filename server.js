const express = require("express");
const axios = require("axios");
const Parser = require("rss-parser");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");
const cron = require("node-cron");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

/* ================= DATABASE ================= */

const db = new sqlite3.Database("news.db");

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    title TEXT,
    summary TEXT,
    content TEXT,
    timeline TEXT,
    vocab TEXT,
    category TEXT,
    image TEXT,
    date TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS blogs (
    id TEXT PRIMARY KEY,
    title TEXT,
    content TEXT,
    image TEXT,
    category TEXT,
    date TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
});

/* ================= RSS SOURCES ================= */

const parser = new Parser();

const feeds = [
  "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
  "https://www.thehindu.com/news/national/feeder/default.rss",
  "http://feeds.bbci.co.uk/news/world/rss.xml",
  "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
  "https://www.moneycontrol.com/rss/latestnews.xml",
  "https://techcrunch.com/feed/",
  "https://www.theverge.com/rss/index.xml"
];

/* ================= AI SYSTEM ================= */

const KEYS = [
  process.env.OPENROUTER_KEY1,
  process.env.OPENROUTER_KEY2,
  process.env.OPENROUTER_KEY3,
  process.env.OPENROUTER_KEY4,
  process.env.OPENROUTER_KEY5,
  process.env.OPENROUTER_KEY6
].filter(Boolean);

let keyIndex = 0;

async function aiGenerate(text) {
  if (KEYS.length === 0) return null;

  for (let i = 0; i < KEYS.length; i++) {
    const key = KEYS[keyIndex % KEYS.length];
    keyIndex++;

    try {
      const res = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: "openai/gpt-3.5-turbo",
          messages: [
            {
              role: "user",
              content: `STRICT JSON ONLY:
{
"title":"",
"points":["","",""],
"article":"",
"timeline":["","","","","",""],
"vocab":[{"word":"","meaning":""},{"word":"","meaning":""},{"word":"","meaning":""},{"word":"","meaning":""}]
}

Text: ${text}`
            }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${key}`
          },
          timeout: 15000
        }
      );

      const content = res.data.choices[0].message.content;

      try {
        return JSON.parse(content);
      } catch {
        return null;
      }

    } catch (err) {
      continue;
    }
  }
  return null;
}

/* ================= CATEGORY ================= */

function detectCategory(text = "") {
  text = text.toLowerCase();
  if (text.includes("india")) return "India";
  if (text.includes("tech")) return "Technology";
  if (text.includes("stock") || text.includes("market")) return "Finance";
  if (text.includes("world")) return "World";
  return "General";
}

/* ================= FETCH NEWS ================= */

async function fetchNews() {
  console.log("Fetching news...");

  for (let url of feeds) {
    try {
      const feed = await parser.parseURL(url);

      for (let item of feed.items.slice(0, 10)) {
        const id = crypto.createHash("md5").update(item.title).digest("hex");

        db.get("SELECT id FROM articles WHERE id=?", [id], async (row) => {
          if (row) return;

          let ai = await aiGenerate(item.contentSnippet || item.title);

          if (!ai) {
            ai = {
              title: item.title,
              points: ["Summary unavailable", "", ""],
              article: item.contentSnippet || "",
              timeline: [],
              vocab: []
            };
          }

          db.run(
            `INSERT INTO articles VALUES (?,?,?,?,?,?,?,?,?)`,
            [
              id,
              ai.title,
              JSON.stringify(ai.points),
              ai.article,
              JSON.stringify(ai.timeline),
              JSON.stringify(ai.vocab),
              detectCategory(item.title),
              item.enclosure?.url || "",
              item.pubDate || new Date().toISOString()
            ]
          );
        });
      }
    } catch (e) {
      console.log("Feed error:", url);
    }
  }
}

/* ================= BLOG GENERATOR ================= */

async function generateBlog() {
  const ai = await aiGenerate("Write a detailed blog about latest global news trends");

  if (!ai) return;

  db.run(
    `INSERT INTO blogs VALUES (?,?,?,?,?,?)`,
    [
      uuidv4(),
      ai.title,
      ai.article,
      "",
      "General",
      new Date().toISOString()
    ]
  );
}

/* ================= AI SEARCH ================= */

async function aiSearch(query) {
  const ai = await aiGenerate(query);
  return ai;
}

/* ================= CRON ================= */

cron.schedule("*/30 * * * *", fetchNews);
cron.schedule("0 */2 * * *", generateBlog);

/* ================= ROUTES ================= */

app.get("/api/news", (req, res) => {
  db.all(
    "SELECT * FROM articles ORDER BY date DESC LIMIT 50",
    [],
    (err, rows) => res.json(rows)
  );
});

app.get("/api/search", (req, res) => {
  const q = "%" + req.query.q + "%";
  db.all(
    `SELECT * FROM articles WHERE title LIKE ? OR content LIKE ? LIMIT 20`,
    [q, q],
    (err, rows) => res.json(rows)
  );
});

app.get("/api/ai-search", async (req, res) => {
  const result = await aiSearch(req.query.q);
  res.json(result || { message: "AI unavailable" });
});

/* ================= FRONTEND ================= */

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>PulseGurgaon</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{margin:0;font-family:sans-serif;background:#f5f5f5}
header{background:linear-gradient(90deg,#ff3b3b,#ff0000);color:white;padding:15px;font-size:20px}
.container{padding:10px}
.card{background:white;padding:15px;margin-bottom:10px;border-radius:12px;box-shadow:0 2px 6px rgba(0,0,0,0.1)}
input{padding:10px;width:70%;border-radius:8px;border:1px solid #ccc}
button{padding:10px;background:red;color:white;border:none;border-radius:8px}
</style>
</head>
<body>

<header>PulseGurgaon</header>

<div class="container">
<input id="search" placeholder="Search or ask AI..."/>
<button onclick="search()">Search</button>
<div id="news"></div>
</div>

<script>
async function loadNews(){
 const res = await fetch('/api/news');
 const data = await res.json();

 document.getElementById('news').innerHTML =
 data.map(n=>\`
  <div class="card">
    <h3>\${n.title}</h3>
    <p>\${JSON.parse(n.summary)[0]}</p>
  </div>
 \`).join('');
}

async function search(){
 const q = document.getElementById('search').value;

 const res = await fetch('/api/ai-search?q='+q);
 const data = await res.json();

 alert(JSON.stringify(data,null,2));
}

loadNews();
</script>

</body>
</html>
`);
});

/* ================= START ================= */

app.listen(PORT, () => {
  console.log("Server running on " + PORT);
});