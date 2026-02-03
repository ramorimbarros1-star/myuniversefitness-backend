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
        Object.entries(AFFILIATE_PARAMS).forEach(([k, v]) => u.searchParams.set(k, v));
        return u.toString();
      } catch {
        return url;
      }
    }

    // ===== Busca (HTML) no site Simple Organic =====
    // Observação: a loja não expõe uma API pública de catálogo como a VTEX.
    // Por isso, usamos a busca do próprio site e extraímos os produtos do HTML.
    const SEARCH_URL = (q) => `${BASE}/search?type=product&q=${encodeURIComponent(q)}`;

    function parseBRL(str) {
      try {
        const s = (str || "")
          .toString()
          .replace(/\u00a0/g, " ")
          .replace(/[^\d,\.]/g, "")
          .trim();
        if (!s) return 0;
        // casos: "69" | "69,90" | "1.299,90"
        const normalized = s.includes(",")
          ? s.replace(/\./g, "").replace(",", ".")
          : s;
        const n = Number(normalized);
        return Number.isFinite(n) ? n : 0;
      } catch {
        return 0;
      }
    }

    function isSoldOutBlock(block) {
      const t = (block || "").toLowerCase();
      return t.includes("esgotado") || t.includes("sold out");
    }

    function extractFirstPrice(block) {
      const m = (block || "").match(/R\$\s*[\d\.\,]+/i);
      return m ? parseBRL(m[0]) : 0;
    }

    function extractFirstImage(block) {
      // tenta pegar uma imagem "real" primeiro
      const img =
        (block || "").match(/<img[^>]+src="([^"]+)"[^>]*>/i) ||
        (block || "").match(/data-src="([^"]+)"/i) ||
        (block || "").match(/srcset="([^"]+)"/i);
      if (!img) return "";
      let u = (img[1] || "").trim();

      // se vier srcset, pega o primeiro item
      if (u.includes(" ")) u = u.split(" ")[0].trim();
      // normaliza //cdn...
      if (u.startsWith("//")) u = "https:" + u;
      return u;
    }

    function extractName(block) {
      // prioridade: alt da imagem
      const alt = (block || "").match(/alt="([^"]+)"/i);
      if (alt && alt[1]) return alt[1].trim();

      // fallback: primeiro h2/h3
      const h = (block || "").match(/<(h2|h3)[^>]*>\s*([^<]+)\s*<\/(h2|h3)>/i);
      if (h && h[2]) return h[2].trim();

      return "";
    }

    function buildAbsUrl(href) {
      if (!href) return "";
      if (/^https?:\/\//i.test(href)) return href;
      if (href.startsWith("/")) return BASE + href;
      return BASE + "/" + href;
    }

    async function simpleSearch(query) {
      const url = SEARCH_URL(query);

      const r = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "user-agent": "Mozilla/5.0",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
        },
      });

      if (!r.ok) {
        console.error("Simple Organic search status:", r.status, url);
        return [];
      }

      const html = await r.text().catch(() => "");
      if (!html) return [];

      // coleta URLs de produtos e um "bloco" próximo para extrair nome/preço/imagem/estoque
      const out = [];
      const seen = new Set();

      const re = /href="(\/products\/[^"#\?]+)"/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        const href = m[1];
        if (!href) continue;

        const abs = buildAbsUrl(href);
        const productUrl = addAffiliate(abs);

        if (seen.has(productUrl)) continue;
        seen.add(productUrl);

        const from = Math.max(0, m.index - 350);
        const to = Math.min(html.length, m.index + 1200);
        const block = html.slice(from, to);

        const nome = extractName(block);
        const foto = extractFirstImage(block);
        const preco = extractFirstPrice(block);
        const soldOut = isSoldOutBlock(block);

        out.push({
          nome: nome || "Produto Simple Organic",
          marca: "Simple Organic",
          foto: foto || "",
          preco: toBRL(preco || 0),
          onde_comprar: productUrl,
          _out: soldOut,
          _type: classifyType(nome),
        });

        if (out.length >= 60) break; // limite seguro por busca
      }

      return out.filter((x) => x && x.onde_comprar && x.onde_comprar.includes("simpleorganic.com.br/products/"));
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
      if (t.includes("51") && t.includes("80")) return [51, 80];
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
      const preco = p.preco && p.preco > 0 ? toBRL(p.preco) : toBRL(Math.max(39.9, BUDGET_MIN || 39.9));

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

    // ✅ fallback só se realmente não tiver nenhum produto
    const fallbackUrl = addAffiliate(`${BASE}/collections/shop-all`);
    while (top5.length < 5) {
      top5.push({
        id: "simple-shopall-" + (top5.length + 1),
        nome: "Sugestões em Shop All (Simple Organic)",
        marca: "Simple Organic",
        preco: toBRL(Math.max(39.9, BUDGET_MIN || 39.9)),
        foto: FACE_FALLBACK_IMGS[top5.length % FACE_FALLBACK_IMGS.length],
        beneficios: ["Veja mais opções disponíveis no site"],
        motivo: "Não encontramos itens suficientes no momento; veja opções na coleção completa.",
        onde_comprar: fallbackUrl,
      });
    }

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
