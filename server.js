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

  db.run(`CREATE TABLE IF NOT EXISTS ads (
    id TEXT PRIMARY KEY,
    image TEXT,
    link TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

});

/* ================= RSS ================= */

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

/* ================= AI ================= */

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
          messages: [{
            role: "user",
            content: `STRICT JSON:
{
"title":"",
"points":["","",""],
"article":"",
"timeline":["","","","","",""],
"vocab":[{"word":"","meaning":""},{"word":"","meaning":""},{"word":"","meaning":""},{"word":"","meaning":""}]
}

Text: ${text}`
          }]
        },
        {
          headers: { Authorization: `Bearer ${key}` },
          timeout: 15000
        }
      );

      return JSON.parse(res.data.choices[0].message.content);

    } catch (e) {
      continue;
    }
  }
  return null;
}

/* ================= CATEGORY ================= */

function detectCategory(text="") {
  text = text.toLowerCase();
  if (text.includes("india")) return "India";
  if (text.includes("tech")) return "Technology";
  if (text.includes("market") || text.includes("stock")) return "Finance";
  if (text.includes("world")) return "World";
  return "General";
}

/* ================= FETCH NEWS ================= */

async function fetchNews() {
  console.log("Fetching news...");

  for (let url of feeds) {
    try {
      const feed = await parser.parseURL(url);

      for (let item of feed.items.slice(0,10)) {

        const id = crypto.createHash("md5").update(item.title).digest("hex");

        db.get("SELECT id FROM articles WHERE id=?", [id], async (row) => {
          if (row) return;

          let ai = await aiGenerate(item.contentSnippet || item.title);

          if (!ai) {
            ai = {
              title: item.title,
              points: ["Summary unavailable","",""],
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

/* ================= BLOG APIs ================= */

app.get("/api/blogs", (req,res)=>{
  db.all("SELECT * FROM blogs ORDER BY date DESC", [], (e,r)=>res.json(r));
});

app.post("/api/blogs", (req,res)=>{
  const {title,content} = req.body;

  db.run(
    `INSERT INTO blogs VALUES (?,?,?,?,?,?)`,
    [
      uuidv4(),
      title,
      content,
      "",
      "General",
      new Date().toISOString()
    ]
  );

  res.json({status:"ok"});
});

app.delete("/api/blogs/:id", (req,res)=>{
  db.run("DELETE FROM blogs WHERE id=?", [req.params.id]);
  res.json({status:"deleted"});
});

/* ================= ADS ================= */

app.get("/api/ads", (req,res)=>{
  db.all("SELECT * FROM ads", [], (e,r)=>res.json(r));
});

app.post("/api/ads", (req,res)=>{
  const {image,link} = req.body;

  db.run(
    `INSERT INTO ads VALUES (?,?,?)`,
    [uuidv4(), image, link]
  );

  res.json({status:"ok"});
});

app.delete("/api/ads/:id", (req,res)=>{
  db.run("DELETE FROM ads WHERE id=?", [req.params.id]);
  res.json({status:"deleted"});
});

/* ================= TICKER ================= */

app.get("/api/ticker", (req,res)=>{
  db.get("SELECT value FROM settings WHERE key='ticker'", [], (e,r)=>{
    res.json({text: r?.value || "Welcome to PulseGurgaon"});
  });
});

app.post("/api/ticker", (req,res)=>{
  const {text} = req.body;

  db.run(
    `INSERT OR REPLACE INTO settings (key,value) VALUES ('ticker',?)`,
    [text]
  );

  res.json({status:"ok"});
});

/* ================= AI SEARCH ================= */

app.get("/api/ai-search", async (req,res)=>{
  const result = await aiGenerate(req.query.q);
  res.json(result || {message:"AI unavailable"});
});

/* ================= NEWS ================= */

app.get("/api/news", (req,res)=>{
  db.all("SELECT * FROM articles ORDER BY date DESC LIMIT 50", [], (e,r)=>res.json(r));
});

/* ================= MANUAL FETCH ================= */

app.get("/api/fetch-news", async (req,res)=>{
  await fetchNews();
  res.json({status:"fetched"});
});

/* ================= BLOG AUTO ================= */

async function generateBlog(){
  const ai = await aiGenerate("Write a blog on latest world trends");
  if(!ai) return;

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

/* ================= CRON ================= */

cron.schedule("*/30 * * * *", fetchNews);
cron.schedule("0 */2 * * *", generateBlog);

/* ================= START ================= */

app.listen(PORT, ()=>{
  console.log("Server running on " + PORT);
});