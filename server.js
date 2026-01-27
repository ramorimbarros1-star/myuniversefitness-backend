// server.js (CommonJS) — Produção: OPAQUE (Tratamento Face) + PIX (FAKE opcional) + Proxy Imagens + Leads (Google Sheets)
// v5: retorna 5 produtos (rotina facial completa) e mantém links /p válidos.

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

// OpenAI (não é obrigatório para a busca)
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

function absoluteUrl(base, u) {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u.replace(/^http:\/\//i, "https://");
  if (u.startsWith("/")) return (base + u).replace(/^http:\/\//i, "https://");
  return (base + "/" + u).replace(/^http:\/\//i, "https://");
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

// ===================== Geração: Busca na OPAQUE (Tratamento/Face) =====================
app.post("/api/generate-products", async (req, res) => {
  try {
    const { answers } = req.body || {};
    if (!answers) return res.status(400).json({ error: "answers ausente" });

    const BASE = "https://www.opaque.com.br";

    // VTEX: rota de categoria + fallback por ft
    const FACE_ROUTE_API = `${BASE}/api/catalog_system/pub/products/search/tratamento/face?_from=0&_to=49`;
    const SEARCH_FT_API = (q) =>
      `${BASE}/api/catalog_system/pub/products/search/?ft=${encodeURIComponent(q)}&_from=0&_to=24`;

    // Fallbacks (skincare/rosto)
    const FACE_FALLBACK_IMGS = [
      "https://images.pexels.com/photos/3762453/pexels-photo-3762453.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/3865792/pexels-photo-3865792.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/3993441/pexels-photo-3993441.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/7581570/pexels-photo-7581570.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/6621464/pexels-photo-6621464.jpeg?auto=compress&cs=tinysrgb&w=800",
    ];

    const FORBIDDEN_TERMS = [
      "infantil","infantis","baby","bebê","bebe","crianca","criança","kids","menino","menina","pediátric","pediatric","júnior","junior"
    ];

    // keywords para manter em “face/skincare”
    const FACE_KEYWORDS = [
      "limpeza","limpador","cleanser","gel de limpeza","espuma","sabonete","agua micelar","água micelar",
      "hidrat","hydr","creme","loção","locao","serum","sérum","vitamina c","niacinamida","ácido","acido",
      "esfol","peeling","protetor","fps","solar","sunscreen","tonico","tônico","anti-idade","antirrugas",
      "rosto","face"
    ];

    function parseBudgetRange(txt) {
      const t = (txt || "").toLowerCase();
      if (t.includes("até r$ 80") || t.includes("ate r$ 80") || t.includes("até 80") || t.includes("ate 80")) return [0, 80];
      if (t.includes("81") || t.includes("r$ 81") || t.includes("81 - 150")) return [81, 150];
      if (t.includes("151") || t.includes("r$ 151") || t.includes("151 - 250")) return [151, 250];
      if (t.includes("251") || t.includes("r$ 251")) return [251, 9999];
      return [0, 9999];
    }

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

    function classifyType(name) {
      const n = (name || "").toLowerCase();
      const has = (arr) => arr.some((k) => n.includes(k));
      if (has(["gel de limpeza","limpeza","limpador","cleanser","sabonete","espuma","agua micelar","água micelar"])) return "cleanser";
      if (has(["hidrat","creme","loção","locao"])) return "moisturizer";
      if (has(["protetor","fps","solar","sunscreen"])) return "sunscreen";
      if (has(["esfol","peeling"])) return "exfoliant";
      if (has(["serum","sérum","vitamina c","niacinamida","ácido","acido"])) return "serum";
      if (has(["tônico","tonico"])) return "toner";
      return "other";
    }

    function buildProductUrlFromVtex(p) {
      const link = (p?.link || "").toString().trim();
      if (link) return absoluteUrl(BASE, link);

      const linkText = (p?.linkText || "").toString().trim();
      if (linkText) return `${BASE}/${linkText}/p`;

      return "";
    }

    function pickImageFromVtex(p) {
      const item = Array.isArray(p?.items) ? p.items[0] : null;
      const img = item?.images?.[0]?.imageUrl || "";
      return absoluteUrl(BASE, img);
    }

    function pickPriceFromVtex(p) {
      const item = Array.isArray(p?.items) ? p.items[0] : null;
      const seller = Array.isArray(item?.sellers) ? item.sellers[0] : null;
      const offer = seller?.commertialOffer || {};
      const price = Number(offer?.Price || offer?.spotPrice || 0);
      const available = Number(offer?.AvailableQuantity || 0);
      return { price: toBRL(price || 0), available };
    }

    function normalizeOpaqueProduct(p) {
      const name = (p?.productName || "").toString().trim();
      const brand = (p?.brand || "Opaque").toString().trim();
      const onde_comprar = buildProductUrlFromVtex(p);
      const foto = pickImageFromVtex(p);
      const { price, available } = pickPriceFromVtex(p);

      return {
        nome: name,
        marca: brand,
        foto: foto ? foto.replace(/^http:\/\//i, "https://") : "",
        preco: price,
        onde_comprar: onde_comprar ? onde_comprar.replace(/^http:\/\//i, "https://") : "",
        _out: available === 0,
        _type: classifyType(name),
      };
    }

    async function fetchJson(url) {
      const r = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "user-agent": "Mozilla/5.0",
          accept: "application/json,text/plain,*/*",
        },
      });
      if (!r.ok) {
        console.error("Opaque API status:", r.status, url);
        return [];
      }
      const data = await r.json().catch(() => []);
      return Array.isArray(data) ? data : [];
    }

    async function opaqueFaceList() {
      const data = await fetchJson(FACE_ROUTE_API);
      return data.map(normalizeOpaqueProduct);
    }

    async function opaqueSearchFt(q) {
      const data = await fetchJson(SEARCH_FT_API(q));
      return data.map(normalizeOpaqueProduct);
    }

    // ------------------- Queries -------------------
    const inc = Array.isArray(answers?.inc) ? answers.inc : [];
    const pele = (answers?.pele || "").toString().toLowerCase();
    const incTxt = inc.join(" ").toLowerCase();

    function buildQuery(cat) {
      const parts = [cat];

      if (pele.includes("oleos")) parts.push("oleosa");
      if (pele.includes("seca")) parts.push("seca");
      if (pele.includes("sens")) parts.push("sensível");

      if (incTxt.includes("acne")) parts.push("acne");
      if (incTxt.includes("mancha")) parts.push("manchas");
      if (incTxt.includes("poros")) parts.push("poros");
      if (incTxt.includes("oleos")) parts.push("controle de oleosidade");
      if (incTxt.includes("ressec") || incTxt.includes("seca")) parts.push("hidratação");

      return parts.join(" ");
    }

    // ✅ 5 produtos (rotina facial): limpeza, sérum, hidratante, protetor, esfoliante
    const mix = [
      "limpeza facial",
      "sérum facial",
      "hidratante facial",
      "protetor solar facial",
      "esfoliante facial",
    ];
    const queries = mix.map(buildQuery);

    const [BUDGET_MIN, BUDGET_MAX] = parseBudgetRange(answers?.orcamento);

    function scoreProduct(p, catText) {
      let s = 0;
      const name = (p.nome || "").toLowerCase();

      // URL válida de produto
      if (!p.onde_comprar || !p.onde_comprar.startsWith(BASE + "/") || !p.onde_comprar.endsWith("/p")) return -Infinity;

      if (!p.nome) return -Infinity;
      if (isForbidden(name)) return -Infinity;

      if (!isFaceCategory(name)) s -= 6;
      else s += 2;

      if (catText) {
        const c = catText.toLowerCase();
        const firstWord = c.split(" ")[0];
        if (firstWord && name.includes(firstWord)) s += 2.0;
        for (const kw of c.split(/\s+/)) {
          if (kw && name.includes(kw)) s += 0.6;
        }
      }

      if (p._out) s -= 10;

      // orçamento
      if (p.preco > 0) {
        if (inBudget(p.preco, BUDGET_MIN, BUDGET_MAX)) s += 2.6;
        else s -= 3.2;
      } else {
        s -= 0.75;
      }

      if (p.foto && isHttps(p.foto)) s += 0.6;
      if (p.marca) s += 0.25;

      return s;
    }

    // Coleta resultados por query (ft) e fallback por lista da categoria
    const results = [];
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];

      let lst = await opaqueSearchFt(q);

      if (!lst || lst.length === 0) {
        const allFace = await opaqueFaceList();
        const qWords = q.toLowerCase().split(/\s+/).filter(Boolean);
        lst = allFace.filter((p) => {
          const n = (p.nome || "").toLowerCase();
          return qWords.some((w) => n.includes(w));
        });
      }

      lst = (lst || [])
        .filter((p) => p && p.nome && p.onde_comprar)
        .filter((p) => !isForbidden(p.nome));

      lst.forEach((p) => results.push({ ...p, _score: scoreProduct(p, mix[i]) }));
    }

    // ========= orçamento (desce faixas se necessário) =========
    const strict = results.filter((p) => p._score > -Infinity && (p.preco > 0 ? inBudget(p.preco, BUDGET_MIN, BUDGET_MAX) : true));
    let pool = strict;

    if (pool.length < 15) {
      const widenMin = Math.max(0, Math.floor(BUDGET_MIN * 0.8));
      const widenMax = Math.ceil(BUDGET_MAX * 1.2);
      pool = results.filter((p) => p._score > -Infinity && (p.preco > 0 ? inBudget(p.preco, widenMin, widenMax) : true));
    }

    if (pool.length < 5) {
      pool = results.filter((p) => p._score > -Infinity && (p.preco > 0 ? p.preco <= BUDGET_MAX : true));
    }

    if (pool.length < 5) {
      pool = results.filter((p) => p._score > -Infinity);
    }

    // ordena e remove duplicatas
    const seen = new Set();
    const ranked = pool
      .sort((a, b) => b._score - a._score)
      .filter((p) => (seen.has(p.onde_comprar) ? false : (seen.add(p.onde_comprar), true)));

    // diversidade por slot (5)
    const preferredTypesBySlot = [
      new Set(["cleanser", "other"]),
      new Set(["serum", "toner", "other"]),
      new Set(["moisturizer", "serum", "other"]),
      new Set(["sunscreen", "other"]),
      new Set(["exfoliant", "other"]),
    ];

    function pickBestForSlot(list, slotIdx, chosenUrls) {
      const preferred = preferredTypesBySlot[slotIdx];
      const candidates = list.filter((p) => !chosenUrls.has(p.onde_comprar));
      const bestPreferred = candidates.filter((p) => preferred.has(p._type)).sort((a, b) => b._score - a._score);
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
      chosen.push(p);
      chosenUrls.add(p.onde_comprar);
    }

    function makeBenefits(p) {
      const n = (p.nome || "").toLowerCase();
      const b = [];
      if (n.includes("vitamina c") || n.includes("c ")) b.push("Ajuda a dar viço e uniformizar o tom");
      if (n.includes("niacin")) b.push("Ajuda no controle de oleosidade e poros");
      if (n.includes("hidrat") || n.includes("hialur")) b.push("Hidratação para o dia a dia");
      if (n.includes("fps") || n.includes("solar") || n.includes("protetor")) b.push("Proteção diária contra o sol");
      if (n.includes("limp") || n.includes("clean") || n.includes("sabonete")) b.push("Limpeza suave para rotina diária");
      if (n.includes("esfol") || n.includes("peeling")) b.push("Renovação e textura mais uniforme");
      if (b.length === 0) b.push("Combina com sua rotina diária de cuidados faciais");
      return b.slice(0, 4);
    }

    const top5 = chosen.slice(0, 5).map((p, i) => {
      const foto = isHttps(p.foto) ? p.foto : FACE_FALLBACK_IMGS[i % FACE_FALLBACK_IMGS.length];
      const preco = p.preco && p.preco > 0 ? toBRL(p.preco) : toBRL(Math.max(49.9, BUDGET_MIN || 49.9));

      return {
        id: ("opaque-face-" + Buffer.from(p.onde_comprar).toString("base64")).replace(/=+$/, ""),
        nome: p.nome,
        marca: p.marca || "Opaque",
        preco,
        foto,
        beneficios: makeBenefits(p),
        motivo: "Selecionado para montar sua rotina facial completa (limpeza, tratamento, hidratação, proteção e renovação), respeitando seu perfil e orçamento.",
        onde_comprar: p.onde_comprar,
      };
    });

    if (top5.length < 5) {
      console.error("Sem produtos suficientes com URL válida. Resultado:", {
        got: top5.length,
        totalRanked: ranked.length,
        totalResults: results.length
      });
      return res.status(502).json({ error: "Não foi possível obter 5 produtos com link válido no momento. Tente novamente." });
    }

    return res.json({ products: top5 });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Falha ao gerar produtos (OPAQUE FACE 5)" });
  }
});

// ===================== PIX: criar cobrança (FAKE ou REAL) =====================
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
