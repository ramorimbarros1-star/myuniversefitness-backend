// server.js (CommonJS) — Produção: OPAQUE (Face) + PIX (FAKE opcional) + Proxy Imagens + Leads (Google Sheets)
// vFinal: (1) exclui indisponíveis de verdade (IsAvailable/AvailableQuantity)
//         (2) busca mais resultados e tenta consultas mais amplas por slot
//         (3) evita cair em /tratamento/face (fallback) quando ainda há produtos reais disponíveis
//         (4) aplica afiliado Rakuten em TODOS os links
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

// Mercado Pago v2
const mercadopago = require("mercadopago");
const { MercadoPagoConfig, Payment } = mercadopago;

// OpenAI (mantido por compatibilidade)
const OpenAI = require("openai");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ===================== CORS =====================
const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS: " + origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options("*", cors());

// ===================== Rate limit =====================
const limiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
app.use(limiter);

// ===================== Flags / Clientes =====================
const isFakePix = process.env.FAKE_PIX === "1";

let mpClient = null;
if (!isFakePix && process.env.MP_ACCESS_TOKEN) {
  mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
}

// OpenAI (compat)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Google Sheets webhook
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || "";

// ===================== Health =====================
app.get("/api/health", (req, res) =>
  res.json({
    ok: true,
    fakePix: isFakePix,
    sheets: !!SHEETS_WEBHOOK_URL,
    corsAllowed: allowedOrigins,
  })
);

function realToNumber(v) {
  return Math.round(Number(v) * 100) / 100;
}
function toBRL(v) {
  return Math.round(Number(v) * 100) / 100;
}
function isHttps(u) {
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
}

// ===================== Salvar Lead no Google Sheets =====================
app.post("/api/save-lead", async (req, res) => {
  try {
    if (!SHEETS_WEBHOOK_URL) {
      return res.status(500).json({ ok: false, error: "SHEETS_WEBHOOK_URL não configurada" });
    }

    const body = req.body || {};
    const nome = (body.nome || "").toString().trim();
    const email = (body.email || "").toString().trim();
    const telefone = (body.telefone || "").toString().trim();

    if (!nome || !email || !telefone) {
      return res.status(400).json({ ok: false, error: "nome/email/telefone são obrigatórios" });
    }

    const payload = {
      nome,
      email,
      telefone,
      origem: (body.origem || "site").toString(),
      utm_source: (body.utm_source || "").toString(),
      utm_medium: (body.utm_medium || "").toString(),
      utm_campaign: (body.utm_campaign || "").toString(),
    };

    const r = await fetch(SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      console.error("Sheets webhook error:", r.status, txt.slice(0, 500));
      return res.status(502).json({ ok: false, error: "Falha ao gravar no Sheets" });
    }

    const data = await r.json().catch(() => ({ ok: true }));
    return res.json({ ok: true, sheets: data });
  } catch (err) {
    console.error("save-lead error:", err);
    return res.status(500).json({ ok: false, error: "Erro interno ao salvar lead" });
  }
});

// ===================== Geração: Busca OPAQUE (Face) =====================
app.post("/api/generate-products", async (req, res) => {
  try {
    const { answers } = req.body || {};
    if (!answers) return res.status(400).json({ error: "answers ausente" });

    const BASE = "https://simpleorganic.com.br";

    // ===== Afiliado Simple Organic (Flip) =====
    const AFFILIATE_PARAMS = {
      influ: "MYUFITNESS",
      utm_source: "flipnet",
      utm_campaign: "MYUFITNESS",
    };
    function addAffiliate(url) {
      try {
        if (!url) return url;
        const u = new URL(url);
        if (!u.hostname.endsWith("simpleorganic.com.br")) return url;

        // garante parâmetros do afiliado (padrão Flip)
        Object.entries(AFFILIATE_PARAMS).forEach(([k, v]) => u.searchParams.set(k, v));

        // remove parâmetros legados que possam confundir
        u.searchParams.delete("utm_content");

        return u.toString();
      } catch {
        return url;
      }
    }

    }

    // ===== Busca (Shopify JSON) no site Simple Organic =====
// A Simple Organic roda em Shopify. Para evitar "preço/imagem errados" (ou fallback), usamos:
// 1) predictive search JSON: /search/suggest.json
// 2) detalhes do produto JSON: /products/<handle>.js

const SUGGEST_URL = (q) =>
  `${BASE}/search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=20&resources[options][unavailable_products]=hide`;

const productCache = new Map(); // handle -> productObj

function normalizeImg(u) {
  if (!u) return "";
  let s = (u || "").toString().trim();
  if (s.startsWith("//")) s = "https:" + s;
  return s;
}

async function fetchJson(url) {
  const r = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json, text/plain, */*",
      "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
    },
  });
  if (!r.ok) return null;
  try {
    return await r.json();
  } catch {
    return null;
  }
}

async function getProductByHandle(handle) {
  if (!handle) return null;
  if (productCache.has(handle)) return productCache.get(handle);

  const url = `${BASE}/products/${handle}.js`;
  const j = await fetchJson(url);
  if (!j || !j.handle) return null;

  const variants = Array.isArray(j.variants) ? j.variants : [];
  const chosenVar = variants.find((v) => v && v.available) || variants[0] || null;

  const price = chosenVar && typeof chosenVar.price === "number" ? chosenVar.price / 100 : 0;
  const available = !!(chosenVar ? chosenVar.available : true);

  const obj = {
    nome: (j.title || "Produto Simple Organic").toString(),
    marca: "Simple Organic",
    foto: normalizeImg(j.featured_image || (Array.isArray(j.images) ? j.images[0] : "")),
    preco: toBRL(price || 0),
    onde_comprar: addAffiliate(`${BASE}/products/${j.handle}`),
    _out: !available,
    _type: classifyType(j.title || ""),
  };

  productCache.set(handle, obj);
  return obj;
}

async function suggestHandles(query) {
  const url = SUGGEST_URL(query);
  const j = await fetchJson(url);
  const products =
    j?.resources?.results?.products ||
    j?.resources?.results?.product ||
    j?.results?.products ||
    [];

  // Normaliza para uma lista de handles
  const handles = [];
  for (const p of products) {
    const handle = (p && (p.handle || p?.url?.split("/products/")[1] || "")).toString().trim();
    if (!handle) continue;
    handles.push(handle.split("?")[0].split("#")[0]);
  }

  return Array.from(new Set(handles));
}

async function simpleSearch(query) {
  // 1) tentativa via suggest.json
  const handles = await suggestHandles(query);
  const out = [];
  for (const h of handles) {
    const p = await getProductByHandle(h);
    if (p) out.push(p);
    if (out.length >= 40) break;
  }
  return out;
}


// fallback images (rotina facial)
    const FACE_FALLBACK_IMGS = [
      "https://images.pexels.com/photos/3762879/pexels-photo-3762879.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/6621457/pexels-photo-6621457.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/3738349/pexels-photo-3738349.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/7755641/pexels-photo-7755641.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/3756450/pexels-photo-3756450.jpeg?auto=compress&cs=tinysrgb&w=800",
    ];

    const FORBIDDEN_TERMS = [
      "infantil","infantis","baby","bebê","bebe","crianca","criança","kids","menino","menina","pediátric","pediatric","júnior","junior"
    ];

    // palavras-chave face / skincare
    const FACE_KEYWORDS = [
      "limpador","limpeza","cleanser","sabonete","gel de limpeza","espuma","água micelar","agua micelar",
      "hidratante","hidratação","hidratacao","moisturizer","creme","gel creme",
      "esfoliante","esfoliação","esfoliacao","scrub","peeling",
      "protetor","protetor solar","fps","sunscreen","solar",
      "sérum","serum","vitamina c","niacinamida","ácido","acido","hialurônico","hialuronico",
      "tônico","tonico","máscara","mascara","face","facial"
    ];

    function isForbidden(name) {
      const n = (name || "").toLowerCase();
      return FORBIDDEN_TERMS.some((t) => n.includes(t));
    }

    function isFaceCategory(name) {
      const n = (name || "").toLowerCase();
      return FACE_KEYWORDS.some((k) => n.includes(k));
    }

    function inBudget(price, min, max) {
      return Number.isFinite(price) && price >= min && price <= max;
    }

    // faixas detalhadas (se o front ainda estiver com antigas, também funciona)
    function parseBudgetRange(txt) {
      const t = (txt || "").toLowerCase();
      if (t.includes("até r$ 50") || t.includes("ate r$ 50") || t.includes("até 50") || t.includes("ate 50")) return [0, 50];
      if (t.includes("até r$ 60") || t.includes("ate r$ 60") || t.includes("até 60") || t.includes("ate 60")) return [0, 60];
      if (t.includes("51") && t.includes("60")) return [51, 60];
      if (t.includes("61") && t.includes("80")) return [61, 80];
      if (t.includes("81") && t.includes("150")) return [81, 150];
      if (t.includes("151") && t.includes("200")) return [151, 200];
      if (t.includes("201") && t.includes("250")) return [201, 250];
      if (t.includes("251") && t.includes("350")) return [251, 350];
      if (t.includes("351") || t.includes("acima") || t.includes("mais de")) return [351, 9999];

      // compat antigo
      if (t.includes("até r$ 80") || t.includes("ate r$ 80") || t.includes("até 80") || t.includes("ate 80")) return [0, 80];
      if (t.includes("81") || t.includes("r$ 81") || t.includes("81 - 150")) return [81, 150];
      if (t.includes("151") || t.includes("r$ 151") || t.includes("151 - 250")) return [151, 250];
      if (t.includes("251") || t.includes("r$ 251")) return [251, 9999];

      return [0, 9999];
    }

    function classifyType(name) {
      const n = (name || "").toLowerCase();
      const has = (arr) => arr.some((k) => n.includes(k));
      if (has(["protetor solar","fps","sunscreen","solar"])) return "sunscreen";
      if (has(["limpador","limpeza","sabonete","gel de limpeza","espuma","agua micelar","água micelar"])) return "cleanser";
      if (has(["hidratante","hidratação","hidratacao","moisturizer"])) return "moisturizer";
      if (has(["esfoliante","esfoliação","esfoliacao","peeling","scrub"])) return "exfoliant";
      if (has(["sérum","serum","vitamina c","niacin","hialuron"])) return "serum";
      if (has(["tônico","tonico"])) return "toner";
      return "other";
    }

    // ===== Respostas =====
    const pele = (answers?.pele || "").toLowerCase(); // oleosa / seca / mista / sensível
    const sensibilidade = (answers?.sensibilidade || "").toLowerCase();
    const inc = Array.isArray(answers?.inc) ? answers.inc : [];
    const incTxt = inc.join(" ").toLowerCase();

    function buildQueryBase(cat) {
      const parts = [cat];

      // contexto face
      parts.push("facial");

      if (pele.includes("oleos")) parts.push("pele oleosa");
      if (pele.includes("seca")) parts.push("pele seca");
      if (pele.includes("mista")) parts.push("pele mista");
      if (pele.includes("sens") || sensibilidade.includes("sim")) parts.push("pele sensível");

      if (incTxt.includes("acne")) parts.push("acne");
      if (incTxt.includes("manchas")) parts.push("manchas");
      if (incTxt.includes("poros")) parts.push("poros");
      if (incTxt.includes("ressec")) parts.push("hidratacao");
      if (incTxt.includes("oleos")) parts.push("controle oleosidade");

      return parts.join(" ");
    }

    // ✅ para cada slot, tentamos “ampliar” a busca se vier poucos resultados
    function slotQueries(cat) {
      const q1 = buildQueryBase(cat);
      const q2 = `${cat} facial`;
      const q3 = `${cat} face`;
      const q4 = cat; // mais amplo
      const q5 = `tratamento facial ${cat}`;
      return [q1, q2, q3, q5, q4];
    }

    const mix = [
      "limpador",
      "hidratante",
      "protetor solar",
      "serum",
      "esfoliante",
    ];

    const [BUDGET_MIN, BUDGET_MAX] = parseBudgetRange(answers?.orcamento);

    function scoreProduct(p, catText) {
      let s = 0;
      const name = (p.nome || "").toLowerCase();

      if (isForbidden(name)) return -Infinity;

      // ✅ indisponível = elimina
      if (p._out) return -Infinity;

      // tem que ser face/skincare
      if (!isFaceCategory(name)) s -= 10;
      else s += 2.5;

      // encaixe com categoria
      if (catText) {
        const token = catText.toLowerCase().trim();
        if (token && name.includes(token)) s += 2.0;
      }

      // sinais por perfil
      if (pele.includes("oleos") && (name.includes("oil") || name.includes("oleos") || name.includes("controle"))) s += 1.2;
      if (pele.includes("seca") && (name.includes("hidrat") || name.includes("hialur") || name.includes("nutri"))) s += 1.2;
      if (incTxt.includes("acne") && (name.includes("acne") || name.includes("salic"))) s += 1.2;
      if (incTxt.includes("manchas") && (name.includes("vitamina c") || name.includes("niacin") || name.includes("clare"))) s += 1.0;
      if ((pele.includes("sens") || sensibilidade.includes("sim")) && (name.includes("sens") || name.includes("suave") || name.includes("calm"))) s += 1.0;

      // orçamento
      if (p.preco > 0) {
        if (inBudget(p.preco, BUDGET_MIN, BUDGET_MAX)) s += 3.0;
        else s -= 3.5;
      } else {
        s -= 0.75;
      }

      if (p.foto && isHttps(p.foto)) s += 0.6;
      if (p.marca) s += 0.25;
      if (p.onde_comprar && p.onde_comprar.includes("simpleorganic.com.br/")) s += 0.6;

      return s;
    }

    // ===== Coleta resultados por slot (com tentativas) =====
    const results = [];
    for (let i = 0; i < mix.length; i++) {
      const cat = mix[i];
      const tries = slotQueries(cat);

      let agg = [];
      for (const q of tries) {
        const lst = await simpleSearch(q);

        // ✅ remove proibidos e indisponíveis já aqui
        const filtered = lst
          .filter((p) => p && p.nome)
          .filter((p) => !isForbidden(p.nome))
          .filter((p) => !p._out);

        agg.push(...filtered);

        // se já tem bastante pro slot, para
        if (agg.length >= 20) break;
      }

      // score e adiciona
      agg.forEach((p) => {
        results.push({
          ...p,
          _slot: i,
          _score: scoreProduct(p, cat),
        });
      });
    }

    // remove -Infinity
    const valid = results.filter((p) => Number.isFinite(p._score) && p._score > -1e9);

    // ===== Lógica de orçamento (com fallback que NÃO vira categoria tão cedo) =====
    let pool = valid.filter((p) => (p.preco > 0 ? inBudget(p.preco, BUDGET_MIN, BUDGET_MAX) : true));

    if (pool.length < 20) {
      const widenMin = Math.max(0, Math.floor(BUDGET_MIN * 0.8));
      const widenMax = Math.ceil(BUDGET_MAX * 1.2);
      pool = valid.filter((p) => (p.preco > 0 ? inBudget(p.preco, widenMin, widenMax) : true));
    }

    if (pool.length < 5) {
      // aceita abaixo do máximo
      pool = valid.filter((p) => (p.preco > 0 ? p.preco <= BUDGET_MAX : true));
    }

    if (pool.length < 5) {
      // remove filtro preço
      pool = valid;
    }

    // ordena e tira duplicatas por URL
    const seen = new Set();
    const ranked = pool
      .sort((a, b) => b._score - a._score)
      .filter((p) => (seen.has(p.onde_comprar) ? false : (seen.add(p.onde_comprar), true)));

    // tipos preferidos por slot
    const preferredTypesBySlot = [
      new Set(["cleanser"]),
      new Set(["moisturizer"]),
      new Set(["sunscreen"]),
      new Set(["serum", "toner"]),
      new Set(["exfoliant"]),
    ];

    function pickBestForSlot(list, slotIdx, chosenUrls) {
      const preferred = preferredTypesBySlot[slotIdx] || new Set();
      const candidates = list
        .filter((p) => !chosenUrls.has(p.onde_comprar))
        .filter((p) => !p._out); // redundância segura

      const bestPreferred = candidates
        .filter((p) => preferred.has(p._type))
        .sort((a, b) => b._score - a._score);

      return bestPreferred[0] || candidates.sort((a, b) => b._score - a._score)[0] || null;
    }

    const chosenUrls = new Set();
    const chosen = [];

    for (let slot = 0; slot < 5; slot++) {
      const p = pickBestForSlot(ranked, slot, chosenUrls);
      if (!p) break;
      chosen.push(p);
      chosenUrls.add(p.onde_comprar);
    }

    // completa se faltou
    let idx = 0;
    while (chosen.length < 5 && idx < ranked.length) {
      const p = ranked[idx++];
      if (!p) break;
      if (chosenUrls.has(p.onde_comprar)) continue;
      if (p._out) continue;
      chosen.push(p);
      chosenUrls.add(p.onde_comprar);
    }

    function makeBenefits(p) {
      const n = (p.nome || "").toLowerCase();
      const b = [];
      if (n.includes("fps") || n.includes("solar")) b.push("Proteção diária para a pele");
      if (n.includes("hidrat") || n.includes("hialur")) b.push("Hidratação e conforto");
      if (n.includes("vitamina c") || n.includes("niacin")) b.push("Ajuda a uniformizar o tom");
      if (n.includes("acne") || n.includes("salic")) b.push("Ajuda no controle de acne/oleosidade");
      if (n.includes("sens") || n.includes("suave")) b.push("Mais gentil para pele sensível");
      if (b.length === 0) b.push("Combina com seu perfil e rotina facial");
      return b.slice(0, 4);
    }

    const top5 = chosen.slice(0, 5).map((p, i) => {
      const foto = isHttps(p.foto) ? p.foto : FACE_FALLBACK_IMGS[i % FACE_FALLBACK_IMGS.length];
            const preco = p.preco && p.preco > 0 ? toBRL(p.preco) : 0;

      return {
        id: ("simple-" + Buffer.from(p.onde_comprar).toString("base64")).replace(/=+$/, ""),
        nome: p.nome,
        marca: p.marca || "Simple Organic",
        preco,
        foto,
        beneficios: makeBenefits(p),
        motivo: "Selecionado para montar uma rotina facial completa (limpeza, hidratação, proteção e tratamento), respeitando seu perfil e orçamento.",
        onde_comprar: addAffiliate(p.onde_comprar),
      };
    });

    return res.json({ products: top5.slice(0, 5) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Falha ao gerar produtos (SIMPLE ORGANIC)" });
  }
});


app.post("/api/create-pix", async (req, res) => {
  try {
    const body = req.body || {};
    const amount = body.amount != null ? body.amount : 4.99;
    const description = body.description || "Desbloqueio recomendações + cupom APP10";
    const nome = body.nome;
    const email = body.email;

    if (isFakePix) {
      return res.json({
        paymentId: 999999,
        qr_base64: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB...",
        copia_cola: "000201FAKEPIX-CODIGO-COPIA-E-COLA",
        fake: true,
        amount,
        description,
      });
    }

    if (!mpClient) return res.status(500).json({ error: "Mercado Pago não configurado" });

    const payment = await new Payment(mpClient).create({
      body: {
        transaction_amount: realToNumber(amount),
        description,
        payment_method_id: "pix",
        payer: {
          email: email || "comprador@example.com",
          first_name: (nome || "Cliente").toString().split(" ")[0],
        },
      },
    });

    const trx = payment?.point_of_interaction?.transaction_data || {};
    const paymentId = payment?.id;

    const rawB64 = (trx.qr_code_base64 || "").toString().trim();

    res.json({
      paymentId,
      qr_base64: rawB64 ? "data:image/png;base64," + rawB64 : "",
      copia_cola: (trx.qr_code || "").toString(),
      fake: false,
      amount,
      description,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Falha ao criar Pix" });
  }
});

// ===================== PIX: status =====================
app.get("/api/charge-status", async (req, res) => {
  try {
    if (isFakePix) return res.json({ status: "approved", fake: true });
    if (!mpClient) return res.status(500).json({ error: "Mercado Pago não configurado" });
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "id ausente" });

    const info = await new Payment(mpClient).get({ id: Number(id) });
    res.json({ status: info?.status || "unknown", fake: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Falha ao consultar status" });
  }
});

// ===================== Proxy de imagens (robusto) =====================
app.get("/api/img", async (req, res) => {
  try {
    const url = (req.query.u || "").toString();
    if (!/^https?:\/\//i.test(url)) return res.status(400).send("Bad url");

    const u = new URL(url);

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      Referer: u.origin + "/",
    };

    const r = await fetch(url, { headers, redirect: "follow" });
    if (!r.ok) {
      console.error("IMG upstream status:", r.status, url);
      return res.status(502).send("Bad upstream");
    }

    const ct = r.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=3600");

    const buf = Buffer.from(await r.arrayBuffer());
    res.end(buf);
  } catch (e) {
    console.error("IMG proxy error:", e);
    res.status(500).send("Proxy error");
  }
});

// ===================== Start =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API on http://0.0.0.0:${PORT}  |  Fake PIX: ${isFakePix ? "ON" : "OFF"}`);
});
