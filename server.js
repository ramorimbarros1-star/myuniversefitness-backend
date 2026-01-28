// server.js (CommonJS) — Produção: OPAQUE (Face) + PIX (FAKE opcional) + Proxy Imagens + Leads (Google Sheets)
// vFinal: Prioridade por (1) tipo de pele (2) incômodos (3) orçamento; sempre retorna 5 produtos; sobe faixa se necessário
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

// Mercado Pago v2
const mercadopago = require("mercadopago");
const { MercadoPagoConfig, Payment } = mercadopago;

// OpenAI (mantido por compatibilidade — não é necessário para essa busca)
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
const DEBUG_RECO = process.env.DEBUG_RECO === "1";

let mpClient = null;
if (!isFakePix && process.env.MP_ACCESS_TOKEN) {
  mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
}

// OpenAI (compat)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Google Sheets webhook
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || "";

// Afiliado Rakuten (Opaque)
const AFFILIATE_QUERY =
  "utm_source=rakuten&utm_medium=afiliados&utm_term=4587713&ranMID=47714&ranEAID=OyPY4YHfHl4&ranSiteID=OyPY4YHfHl4-5t9np1DoTPuG6fO28twrDA";

// ===================== Health =====================
app.get("/api/health", (req, res) =>
  res.json({
    ok: true,
    fakePix: isFakePix,
    sheets: !!SHEETS_WEBHOOK_URL,
    corsAllowed: allowedOrigins,
    debugReco: DEBUG_RECO,
  })
);

function realToNumber(v) {
  return Math.round(Number(v) * 100) / 100;
}

function toBRL(v) {
  return Math.round(Number(v || 0) * 100) / 100;
}

function isHttps(u) {
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
}

function withAffiliate(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    // preserva query existente e adiciona afiliado
    const aff = new URLSearchParams(AFFILIATE_QUERY);
    aff.forEach((val, key) => {
      if (!u.searchParams.has(key)) u.searchParams.set(key, val);
    });
    return u.toString();
  } catch {
    // se não for URL válida, devolve sem modificar
    return url;
  }
}

// ===================== Normalização texto (para match robusto) =====================
function normalizeText(str) {
  return (str || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function kwHitScore(productName, kw, weight) {
  const n = normalizeText(productName);
  const k = normalizeText(kw);

  if (!k) return 0;

  // bate frase inteira -> ganha mais
  if (n.includes(k)) return weight * 1.25;

  const stop = new Set(["pele", "de", "da", "do", "das", "dos", "para", "com", "sem", "e", "a", "o"]);
  const tokens = k.split(/\s+/).filter((t) => t.length >= 4 && !stop.has(t));

  let hits = 0;
  for (const t of tokens) if (n.includes(t)) hits++;

  if (hits === 0) return 0;
  return weight * (0.5 + 0.35 * hits);
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

// ===================== Geração: Busca na OPAQUE (Face/Skincare) =====================
app.post("/api/generate-products", async (req, res) => {
  try {
    const { answers } = req.body || {};
    if (!answers) return res.status(400).json({ error: "answers ausente" });

    const BASE = "https://www.opaque.com.br";

    // VTEX legacy search (JSON)
    const SEARCH_API = (q, from = 0, to = 49) =>
      `${BASE}/api/catalog_system/pub/products/search/?ft=${encodeURIComponent(q)}&O=OrderByBestDiscountDESC&_from=${from}&_to=${to}`;

    // Fallbacks (skincare/face)
    const FACE_FALLBACK_IMGS = [
      "https://images.pexels.com/photos/3762879/pexels-photo-3762879.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/3737594/pexels-photo-3737594.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/6621291/pexels-photo-6621291.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/6621161/pexels-photo-6621161.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/6621221/pexels-photo-6621221.jpeg?auto=compress&cs=tinysrgb&w=800",
    ];

    const FORBIDDEN_TERMS = [
      "infantil",
      "infantis",
      "baby",
      "bebê",
      "bebe",
      "crianca",
      "criança",
      "kids",
      "menino",
      "menina",
      "pediátric",
      "pediatric",
      "júnior",
      "junior",
    ];

    // Palavras-chave para garantir que seja “Face / Skincare”
    const FACE_KEYWORDS_STRONG = [
      "facial",
      "face",
      "rosto",
      "pele",
      "cleanser",
      "limpeza",
      "demaquilante",
      "tônico",
      "tonico",
      "serum",
      "sérum",
      "hidratante",
      "moistur",
      "protetor",
      "spf",
      "fps",
      "sunscreen",
      "esfoliante",
      "peeling",
      "ácido",
      "acido",
      "vitamina c",
      "niacinamida",
      "retinol",
      "hialur",
      "olhos",
      "eye",
      "anti-idade",
      "antissinais",
      "manchas",
      "clareador",
    ];

    function isForbidden(name) {
      const n = normalizeText(name);
      return FORBIDDEN_TERMS.some((t) => n.includes(normalizeText(t)));
    }

    function looksFaceProduct(name) {
      const n = normalizeText(name);
      return FACE_KEYWORDS_STRONG.some((k) => n.includes(normalizeText(k)));
    }

    function classifyType(name) {
      const n = normalizeText(name);
      const has = (arr) => arr.some((k) => n.includes(normalizeText(k)));

      if (has(["protetor", "sunscreen", "fps", "spf"])) return "sunscreen";
      if (has(["gel de limpeza", "limpeza", "cleanser", "sabonte", "sabonete", "cleansing", "demaquilante"])) return "cleanser";
      if (has(["hidrat", "moistur", "creme facial"])) return "moisturizer";
      if (has(["serum", "serum", "vitamina c", "niacinamida", "retinol", "acido", "hialur"])) return "treatment";
      if (has(["esfol", "peeling", "tonico", "tônico"])) return "exfoliant";
      if (has(["olhos", "eye"])) return "eye";
      return "other";
    }

    // Orçamento
    const BUDGET_BANDS = [
      { label: "Até R$ 60", min: 0, max: 60 },
      { label: "R$ 61 - R$ 120", min: 61, max: 120 },
      { label: "R$ 121 - R$ 200", min: 121, max: 200 },
      { label: "R$ 201 - R$ 350", min: 201, max: 350 },
      { label: "R$ 351 - R$ 600", min: 351, max: 600 },
      { label: "R$ 601+", min: 601, max: 999999 },
    ];

    function bandIndexFromText(txt) {
      const t = normalizeText(txt);
      if (/ate\s*r?\$?\s*60|até\s*r?\$?\s*60|ate\s*60|até\s*60/.test(t)) return 0;
      if (/(61)\s*[-a]\s*(120)/.test(t)) return 1;
      if (/(121)\s*[-a]\s*(200)/.test(t)) return 2;
      if (/(201)\s*[-a]\s*(350)/.test(t)) return 3;
      if (/(351)\s*[-a]\s*(600)/.test(t)) return 4;
      if (/(601)\s*\+|acima\s*de\s*601|mais\s*de\s*601/.test(t)) return 5;
      return 1;
    }

    function inBand(price, band) {
      if (!Number.isFinite(price) || price <= 0) return false;
      return price >= band.min && price <= band.max;
    }

    function normalizeOpaqueProduct(p) {
      const name = p?.productName || "";
      const brand = p?.brand || "Opaque";
      const linkText = p?.linkText || "";
      const productId = p?.productId || "";

      let url = p?.link || "";
      if (!url && linkText) url = `${BASE}/${linkText}/p`;
      if (!url && productId) url = `${BASE}/p/${productId}`;

      const item = Array.isArray(p?.items) ? p.items[0] : null;
      const img = item?.images?.[0]?.imageUrl || "";

      const seller = Array.isArray(item?.sellers) ? item.sellers[0] : null;
      const offer = seller?.commertialOffer || {};
      const price = Number(offer?.Price || offer?.spotPrice || 0);
      const availableRaw = offer?.AvailableQuantity;
      const available = Number.isFinite(Number(availableRaw)) ? Number(availableRaw) : null;

      return {
        nome: name,
        marca: brand,
        foto: img,
        preco: toBRL(price || 0),
        onde_comprar: url,
        _out: available === 0, // só marca out-of-stock se a VTEX informar 0 explicitamente
        _type: classifyType(name),
      };
    }

    async function opaqueSearch(query) {
      const url = SEARCH_API(query, 0, 49);
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
      if (!Array.isArray(data)) return [];

      return data.map(normalizeOpaqueProduct).filter((x) => x && x.nome && x.onde_comprar);
    }

    // ========= PRIORIDADE: (1) Tipo de pele =========
    const pele = (answers?.pele || "").toString().toLowerCase();

    // aceita array (frontend manda array), mas também string, etc.
    const rawInc = answers?.inc ?? [];
    const inc = Array.isArray(rawInc)
      ? rawInc.map((x) => String(x))
      : typeof rawInc === "string"
      ? rawInc.split(/[;,|]/g).map((s) => s.trim()).filter(Boolean)
      : [];

    function skinKeywords() {
      if (pele.includes("oleos")) return ["oleosa", "oleosidade", "matificante", "oil free"];
      if (pele.includes("seca")) return ["seca", "hidratante", "nutritivo", "barreira"];
      if (pele.includes("sens")) return ["sensivel", "calmante", "suave", "sem fragrancia"];
      if (pele.includes("mista")) return ["mista", "equilibrante", "zona t"];
      return ["normal", "hidratacao leve"];
    }

    // ========= PRIORIDADE: (2) Incômodos =========
    function concernKeywords() {
      const kws = [];
      const txt = (inc || []).join(" ").toLowerCase();

      if (txt.includes("oleos")) kws.push("oleosidade", "poros");
      if (txt.includes("acne")) kws.push("acne", "salicilico", "cravos");
      if (txt.includes("poros")) kws.push("poros");
      if (txt.includes("manchas")) kws.push("vitamina c", "niacinamida", "clareador");
      if (txt.includes("ressec")) kws.push("hidratante", "hialuronico");
      if (txt.includes("sensib")) kws.push("calmante", "barreira", "vermelhidao");
      if (txt.includes("linhas")) kws.push("retinol", "antissinais", "firmador");
      if (txt.includes("olheiras")) kws.push("olhos", "eye");

      return kws.slice(0, 6);
    }

    const SKIN_KW = skinKeywords();
    const CONCERN_KW = concernKeywords();

    // ========= “SLOTS” (sempre 5 produtos) =========
    const SLOT_CATS = [
      { want: "cleanser", base: "limpeza facial gel de limpeza" },
      { want: "moisturizer", base: "hidratante facial" },
      { want: "sunscreen", base: "protetor solar facial fps" },
      { want: "treatment", base: "serum facial" },
      { want: "exfoliant", base: "tonico facial esfoliante" },
    ];

    // Query mais “limpa” (menos poluição = melhor retorno)
    function buildQuery(slotBase) {
      const parts = [];
      if (SKIN_KW[0]) parts.push(SKIN_KW[0]);         // ex: "oleosa"
      if (CONCERN_KW[0]) parts.push(CONCERN_KW[0]);   // ex: "acne"
      parts.push(slotBase);                           // ex: "hidratante facial"
      parts.push("facial");
      return parts.join(" ");
    }

    // ========= SCORE =========
    const SCORE = {
      skinHit: 6.0,
      concernHit: 3.2,
      slotHit: 3.0,
      faceBonus: 2.0,
      outPenalty: -10,
      nonFacePenalty: -8,
    };

    function scoreProduct(p, slot) {
      let s = 0;
      const name = p?.nome || "";
      if (isForbidden(name)) return -Infinity;

      if (p._out) s += SCORE.outPenalty;

      const faceOk = looksFaceProduct(name);
      if (faceOk) s += SCORE.faceBonus;
      else s += SCORE.nonFacePenalty;

      // Pele (prioridade #1)
      for (const kw of SKIN_KW.slice(0, 3)) s += kwHitScore(name, kw, SCORE.skinHit);

      // Incômodos (prioridade #2)
      for (const kw of CONCERN_KW.slice(0, 4)) s += kwHitScore(name, kw, SCORE.concernHit);

      // Slot (categoria do produto)
      const want = slot.want;
      const t = classifyType(name);
      if (want === "cleanser" && t === "cleanser") s += SCORE.slotHit;
      if (want === "moisturizer" && t === "moisturizer") s += SCORE.slotHit;
      if (want === "sunscreen" && t === "sunscreen") s += SCORE.slotHit;
      if (want === "treatment" && t === "treatment") s += SCORE.slotHit;
      if (want === "exfoliant" && ["exfoliant", "eye"].includes(t)) s += SCORE.slotHit;

      // url/imagem
      if (p.onde_comprar && p.onde_comprar.startsWith(BASE + "/")) s += 0.6;
      if (p.foto && isHttps(p.foto)) s += 0.4;

      return s;
    }

    if (DEBUG_RECO) {
      console.log("[generate-products] answers:", JSON.stringify(answers));
      console.log("[generate-products] pele:", pele, "| inc:", inc, "| orcamento:", answers?.orcamento);
      console.log("[generate-products] SKIN_KW:", SKIN_KW, "| CONCERN_KW:", CONCERN_KW);
    }

    // ========= 1) Busca por slot =========
    const perSlot = [];
    for (const slot of SLOT_CATS) {
      const q = buildQuery(slot.base);
      let list = await opaqueSearch(q);

      list = list
        .map((x) => ({
          ...x,
          onde_comprar: withAffiliate(x.onde_comprar),
        }))
        .filter((p) => p && p.nome && p.onde_comprar)
        .filter((p) => !isForbidden(p.nome))
        .filter((p) => !p._out);

      list = list.map((p) => ({ ...p, _score: scoreProduct(p, slot), _slot: slot.want }));
      list = list.filter((p) => p._score > -Infinity);

      if (DEBUG_RECO) {
        console.log("[slot]", slot.want, "query=", q, "items=", list.length);
        console.log(
          "[slot top]",
          slot.want,
          list
            .slice()
            .sort((a, b) => b._score - a._score)
            .slice(0, 3)
            .map((x) => ({ nome: x.nome, preco: x.preco, score: x._score }))
        );
      }

      perSlot.push(list);
    }

    // ========= 2) Pool =========
    const poolAll = perSlot.flat();

    // ========= 3) Orçamento =========
    const startBandIdx = bandIndexFromText(answers?.orcamento);
    let chosenBandIdx = startBandIdx;

    function pickFromBand(bandIdx) {
      const band = BUDGET_BANDS[bandIdx] || BUDGET_BANDS[startBandIdx];
      const bandPool = poolAll.filter((p) => p.preco > 0 && inBand(p.preco, band));
      return { band, bandPool };
    }

    let bandInfo = pickFromBand(chosenBandIdx);

// Regra de negócio (ajuste):
// - Se não tiver 5 itens na faixa escolhida, tenta APENAS a próxima faixa imediata.
// - Se ainda assim não tiver 5, completa com itens fora da faixa (mas mantendo produtos reais).
if (bandInfo.bandPool.length < 5 && chosenBandIdx < BUDGET_BANDS.length - 1) {
  chosenBandIdx = chosenBandIdx + 1;
  bandInfo = pickFromBand(chosenBandIdx);
}

let finalPool = bandInfo.bandPool;
let note = "";

const fromLabel = BUDGET_BANDS[startBandIdx]?.label || "sua faixa";
const toLabel = BUDGET_BANDS[chosenBandIdx]?.label || "faixa acima";

if (chosenBandIdx !== startBandIdx) {
  note = `Não encontramos 5 produtos na faixa "${fromLabel}". Por isso mostramos opções na próxima faixa: "${toLabel}".`;
}

// Se mesmo na próxima faixa não houver itens suficientes, completa com itens fora da faixa
// (evita cair em links genéricos de categoria).
if (finalPool.length < 5) {
  const extraPool = poolAll.filter((p) => p && p.preco > 0);
  // mantém a ordem por score, mas dá preferência aos que já estavam no pool da faixa
  const extraSorted = extraPool.sort((a, b) => b._score - a._score);
  finalPool = Array.from(new Map([...finalPool, ...extraSorted].map((p) => [p.onde_comprar, p])).values());
  if (!note) {
    note = `Não encontramos 5 produtos na faixa "${fromLabel}". Mostramos as melhores opções disponíveis e completamos com itens fora da faixa para fechar 5 recomendações.`;
  } else {
    note += " Como ainda não havia 5 itens, completamos com as melhores opções disponíveis fora da faixa.";
  }
}

    // ========= 4) Seleciona 1 por slot, depois completa =========
    const chosen = [];
    const usedUrls = new Set();

    function bestForSlot(slotWant) {
      const candidates = finalPool
        .filter((p) => p._slot === slotWant)
        .filter((p) => !usedUrls.has(p.onde_comprar))
        .sort((a, b) => b._score - a._score);

      return candidates[0] || null;
    }

    for (const slot of SLOT_CATS) {
      const p = bestForSlot(slot.want);
      if (p) {
        chosen.push(p);
        usedUrls.add(p.onde_comprar);
      }
    }

    const remaining = finalPool
      .filter((p) => !usedUrls.has(p.onde_comprar))
      .sort((a, b) => b._score - a._score);

    for (const p of remaining) {
      if (chosen.length >= 5) break;
      chosen.push(p);
      usedUrls.add(p.onde_comprar);
    }

    // Se ainda faltarem itens (por exemplo, por falta de estoque/preço),
    // amplia a busca para o pool inteiro (mantendo produtos reais).
    if (chosen.length < 5) {
      const broad = poolAll
        .filter((p) => p && p.onde_comprar && !usedUrls.has(p.onde_comprar))
        .sort((a, b) => b._score - a._score);

      for (const p of broad) {
        if (chosen.length >= 5) break;
        chosen.push(p);
        usedUrls.add(p.onde_comprar);
      }
    }

    // ========= 5) fallback =========
    let fallbackCursor = 0;
    if (chosen.length < 5) {
      const fallbackQuery = `${SKIN_KW[0] || "pele"} ${CONCERN_KW[0] || ""} tratamento facial`;
      let extra = await opaqueSearch(fallbackQuery);
      extra = extra
        .map((x) => ({ ...x, onde_comprar: withAffiliate(x.onde_comprar) }))
        .filter((p) => p && p.nome && p.onde_comprar)
        .filter((p) => !isForbidden(p.nome))
        .filter((p) => !p._out)
        .map((p) => ({ ...p, _score: 0.1, _slot: "extra" }));

      while (chosen.length < 5 && fallbackCursor < extra.length) {
        const p = extra[fallbackCursor++];
        if (!p || usedUrls.has(p.onde_comprar)) continue;
        chosen.push(p);
        usedUrls.add(p.onde_comprar);
      }
    }

    // ========= 6) resposta final =========
    function makeBenefits(p) {
      const n = normalizeText(p.nome);
      const b = [];
      if (n.includes("fps") || n.includes("spf") || n.includes("protetor")) b.push("Proteção diária para a pele");
      if (n.includes("hidrat")) b.push("Ajuda a manter a hidratação");
      if (n.includes("vitamina c") || n.includes("niacin") || n.includes("clare")) b.push("Foco em uniformização/manchas");
      if (n.includes("retinol") || n.includes("anti-idade") || n.includes("antissinais")) b.push("Apoio para linhas/idade");
      if (n.includes("oleos") || n.includes("oil")) b.push("Ajuda no controle de oleosidade");
      if (n.includes("acne") || n.includes("salic") || n.includes("cravo")) b.push("Apoio para acne/cravos");
      if (b.length === 0) b.push("Combina com seu perfil (pele e objetivos)");
      return b.slice(0, 4);
    }

    const final = chosen.slice(0, 5).map((p, i) => {
      const foto = isHttps(p.foto) ? p.foto : FACE_FALLBACK_IMGS[i % FACE_FALLBACK_IMGS.length];

      return {
        id: ("opaque-" + Buffer.from(p.onde_comprar || (p.nome || "x")).toString("base64")).replace(/=+$/, ""),
        nome: p.nome || "Produto facial",
        marca: p.marca || "Opaque",
        preco: p.preco && p.preco > 0 ? toBRL(p.preco) : toBRL(Math.max(59.9, BUDGET_BANDS[startBandIdx]?.min || 59.9)),
        foto,
        beneficios: makeBenefits(p),
        motivo: "Priorizamos tipo de pele e objetivos informados para sugerir itens coerentes para sua rotina.",
        onde_comprar: p.onde_comprar ? withAffiliate(p.onde_comprar) : "",
      };
    });

    while (final.length < 5) {
      const idx = final.length;
      final.push({
        id: "opaque-fallback-" + (idx + 1),
        nome: "Veja mais opções de Face na Opaque",
        marca: "Opaque",
        preco: toBRL(Math.max(59.9, BUDGET_BANDS[startBandIdx]?.min || 59.9)),
        foto: FACE_FALLBACK_IMGS[idx % FACE_FALLBACK_IMGS.length],
        beneficios: ["Explore mais opções na categoria Face"],
        motivo: "Não havia itens suficientes no momento. Esta sugestão leva você para mais opções disponíveis.",
        onde_comprar: withAffiliate(`${BASE}/tratamento/face`),
      });
    }

    return res.json({ products: final.slice(0, 5), note });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Falha ao gerar produtos (OPAQUE/Face)" });
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
        qr_base64: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB...", // placeholder
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