// server.js (CommonJS) — Produção: OPAQUE (Tratamento/Face) + 5 produtos + PIX (FAKE opcional) + Proxy Imagens + Leads (Google Sheets)
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

// Mercado Pago v2
const mercadopago = require("mercadopago");
const { MercadoPagoConfig, Payment } = mercadopago;

// OpenAI (mantido por compatibilidade - não é obrigatório neste fluxo)
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

// OpenAI (compatibilidade)
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
const toBRL = (v) => Math.round(Number(v) * 100) / 100;

const isHttps = (u) => {
  try { return new URL(u).protocol === "https:"; } catch { return false; }
};

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
      created_at: new Date().toISOString(),
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

// ===================== Geração: Busca na OPAQUE (Tratamento/Face) — 5 produtos =====================
app.post("/api/generate-products", async (req, res) => {
  try {
    const { answers } = req.body || {};
    if (!answers) return res.status(400).json({ error: "answers ausente" });

    const BASE = "https://www.opaque.com.br";

    // VTEX search (JSON) — ft=termo
    const SEARCH_API = (q) =>
      `${BASE}/api/catalog_system/pub/products/search/?ft=${encodeURIComponent(q)}&O=OrderByBestDiscountDESC&_from=0&_to=30`;

    // Fallbacks (skincare / rosto)
    const FACE_FALLBACK_IMGS = [
      "https://images.pexels.com/photos/3762879/pexels-photo-3762879.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/3738351/pexels-photo-3738351.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/3762453/pexels-photo-3762453.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/3762853/pexels-photo-3762853.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/3762579/pexels-photo-3762579.jpeg?auto=compress&cs=tinysrgb&w=800",
    ];

    const FORBIDDEN_TERMS = [
      "infantil","infantis","baby","bebê","bebe","crianca","criança","kids","menino","menina","pediátric","pediatric","júnior","junior"
    ];

    // Palavras-chave para “tratamento facial”
    const FACE_KEYWORDS = [
      "face","facial","limpeza","cleanser","cleansing","espuma","gel de limpeza",
      "hidrat","moistur","creme","serum","sérum","anti-idade","antirrugas","vitamina c","niacinamida",
      "protetor","solar","spf","fps","sunscreen",
      "esfol","peeling","ácido","acido","toner","tônico","tonico","água micelar","agua micelar",
      "olhos","eye","olheiras"
    ];

    const inBudget = (price, min, max) => Number.isFinite(price) && price >= min && price <= max;

    function parseBudgetRange(txt) {
      const t = (txt || "").toLowerCase();
      if (t.includes("até r$ 60") || t.includes("ate r$ 60") || t.includes("até 60") || t.includes("ate 60")) return [0, 60];
      if (t.includes("61") || t.includes("r$ 61") || t.includes("61 - 120")) return [61, 120];
      if (t.includes("121") || t.includes("r$ 121") || t.includes("121 - 200")) return [121, 200];
      if (t.includes("201") || t.includes("r$ 201") || t.includes("201 - 350")) return [201, 350];
      if (t.includes("351") || t.includes("r$ 351") || t.includes("351 - 600")) return [351, 600];
      if (t.includes("601")) return [601, 99999];
      return [0, 99999];
    }

    function isForbidden(name) {
      const n = (name || "").toLowerCase();
      return FORBIDDEN_TERMS.some((t) => n.includes(t));
    }

    function isFaceCategory(name) {
      const n = (name || "").toLowerCase();
      return FACE_KEYWORDS.some((k) => n.includes(k));
    }

    function classifyType(name) {
      const n = (name || "").toLowerCase();
      const has = (arr) => arr.some((k) => n.includes(k));
      if (has(["limpeza","cleanser","cleansing","espuma","gel de limpeza","agua micelar","água micelar"])) return "cleanser";
      if (has(["hidrat","moistur","creme","gel-creme","gel creme"])) return "moisturizer";
      if (has(["protetor","solar","spf","fps","sunscreen"])) return "sunscreen";
      if (has(["esfol","peeling"])) return "exfoliant";
      if (has(["serum","sérum","vitamina c","niacinamida","anti-idade","antirrugas","ácido","acido","toner","tônico","tonico"])) return "treatment";
      return "other";
    }

    function looksLikeFaceProduct(p) {
      const name = (p?.productName || "").toString();
      if (!name) return false;
      if (isForbidden(name)) return false;
      // pelo menos alguma pista de facial
      return isFaceCategory(name);
    }

    function isFaceFromCategories(p) {
      // VTEX geralmente traz categories: ["/Tratamento/Face/..."]
      const cats = Array.isArray(p?.categories) ? p.categories : [];
      const joined = cats.join(" ").toLowerCase();
      // tenta forçar “tratamento/face”
      return joined.includes("/tratamento/face");
    }

    function normalizeOpaqueProduct(p) {
      const name = (p?.productName || "").toString();
      const brand = (p?.brand || "Opaque").toString();

      const linkText = (p?.linkText || "").toString().trim();
      // ✅ Aqui está o ponto mais importante: link REAL do produto
      const where = linkText ? `${BASE}/${linkText}/p` : "";

      const item = Array.isArray(p?.items) ? p.items[0] : null;
      const img = item?.images?.[0]?.imageUrl || "";
      const seller = Array.isArray(item?.sellers) ? item.sellers[0] : null;
      const offer = seller?.commertialOffer || {};

      const price = Number(offer?.Price || offer?.spotPrice || 0);
      const available = Number(offer?.AvailableQuantity || 0);

      return {
        nome: name,
        marca: brand,
        foto: img,
        preco: toBRL(price || 0),
        onde_comprar: where,
        _out: available === 0,
        _type: classifyType(name),
        _isFaceCat: isFaceFromCategories(p),
      };
    }

    async function opaqueSearch(query) {
      const url = SEARCH_API(query);

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

      return data
        .filter(looksLikeFaceProduct)
        .map(normalizeOpaqueProduct)
        // ✅ só aceita produto se tiver link de produto
        .filter((x) => x && x.nome && x.onde_comprar && x.onde_comprar.startsWith(BASE + "/"));
    }

    // --------- Monta as buscas com base nas respostas ----------
    const pele = (answers?.pele || "").toLowerCase();
    const sens = (answers?.sensibilidade || "").toLowerCase();
    const rotina = (answers?.rotina || "").toLowerCase();
    const protetor = (answers?.protetor || "").toLowerCase();
    const textura = (answers?.textura || "").toLowerCase();
    const inc = Array.isArray(answers?.inc) ? answers.inc : [];

    function buildQuery(slotBase) {
      const parts = [slotBase, "face", "facial"];

      if (pele.includes("oleos")) parts.push("pele oleosa");
      if (pele.includes("seca")) parts.push("pele seca");
      if (pele.includes("mista")) parts.push("pele mista");
      if (pele.includes("sens")) parts.push("pele sensível");

      if (sens.includes("alta")) parts.push("sensível");
      if (sens.includes("média") || sens.includes("media")) parts.push("suave");

      if (textura.includes("leve")) parts.push("textura leve");
      if (textura.includes("crem")) parts.push("creme");

      const incTxt = inc.join(" ").toLowerCase();
      if (incTxt.includes("oleos")) parts.push("controle de oleosidade");
      if (incTxt.includes("acne")) parts.push("acne");
      if (incTxt.includes("poros")) parts.push("poros");
      if (incTxt.includes("manchas")) parts.push("manchas");
      if (incTxt.includes("ressec")) parts.push("hidratacao");
      if (incTxt.includes("sensib")) parts.push("calmante");
      if (incTxt.includes("linhas")) parts.push("anti-idade");
      if (incTxt.includes("olheiras")) parts.push("olhos");

      // se a pessoa não usa protetor, prioriza protetor “diário”
      if (slotBase.includes("protetor") && protetor.includes("não")) parts.push("uso diário");

      return parts.join(" ");
    }

    // ✅ 5 slots (diversidade)
    const slots = [
      { label: "Limpeza", q: buildQuery("limpeza") , want: new Set(["cleanser"]) },
      { label: "Hidratação", q: buildQuery("hidratante") , want: new Set(["moisturizer"]) },
      { label: "Proteção solar", q: buildQuery("protetor solar") , want: new Set(["sunscreen"]) },
      { label: "Esfoliação", q: buildQuery("esfoliante") , want: new Set(["exfoliant"]) },
      { label: "Tratamento", q: buildQuery("sérum") , want: new Set(["treatment","other"]) },
    ];

    const [BUDGET_MIN, BUDGET_MAX] = parseBudgetRange(answers?.orcamento);

    function scoreProduct(p, slotLabel) {
      let s = 0;
      const name = (p.nome || "").toLowerCase();

      if (isForbidden(name)) return -Infinity;
      if (p._out) s -= 10;

      // facial
      if (isFaceCategory(name)) s += 2.0;
      else s -= 8.0;

      // categoria face via categories ajuda muito
      if (p._isFaceCat) s += 2.0;

      // orçamento: puxa para dentro
      if (p.preco > 0) {
        if (inBudget(p.preco, BUDGET_MIN, BUDGET_MAX)) s += 3.0;
        else s -= 3.4;
      } else {
        s -= 0.75;
      }

      // bônus por foto/link
      if (p.foto && isHttps(p.foto)) s += 0.7;
      if (p.onde_comprar) s += 0.7;
      if (p.marca) s += 0.2;

      // match simples por “slot”
      const slot = (slotLabel || "").toLowerCase();
      if (slot.includes("limpeza") && (name.includes("clean") || name.includes("limp") || name.includes("micelar"))) s += 1.8;
      if (slot.includes("hidr") && (name.includes("hidrat") || name.includes("moist") || name.includes("creme"))) s += 1.6;
      if (slot.includes("prote") && (name.includes("spf") || name.includes("fps") || name.includes("solar"))) s += 2.2;
      if (slot.includes("esfol") && (name.includes("esfol") || name.includes("peeling"))) s += 1.9;
      if (slot.includes("trat") && (name.includes("serum") || name.includes("sérum") || name.includes("vitamina") || name.includes("niacin"))) s += 1.8;

      return s;
    }

    // busca e monta pool
    const results = [];
    for (const slot of slots) {
      const lst = await opaqueSearch(slot.q);
      lst.forEach((p) => results.push({ ...p, _score: scoreProduct(p, slot.label) }));
    }

    // ===================== Orçamento (desce faixas se necessário) =====================
    const strict = results.filter((p) => p._score > -Infinity && (p.preco > 0 ? inBudget(p.preco, BUDGET_MIN, BUDGET_MAX) : true));
    let pool = strict;

    // amplia ±20% se pouco resultado
    if (pool.length < 12) {
      const widenMin = Math.max(0, Math.floor(BUDGET_MIN * 0.8));
      const widenMax = Math.ceil(BUDGET_MAX * 1.2);
      pool = results.filter((p) => p._score > -Infinity && (p.preco > 0 ? inBudget(p.preco, widenMin, widenMax) : true));
    }

    // se ainda faltar, aceita abaixo do máximo (resolve faixas altas sem produto)
    if (pool.length < 5) {
      pool = results.filter((p) => p._score > -Infinity && (p.preco > 0 ? p.preco <= BUDGET_MAX : true));
    }

    // último fallback: sem preço
    if (pool.length < 5) {
      pool = results.filter((p) => p._score > -Infinity);
    }

    // remove duplicatas
    const seen = new Set();
    const ranked = pool
      .sort((a, b) => b._score - a._score)
      .filter((p) => (seen.has(p.onde_comprar) ? false : (seen.add(p.onde_comprar), true)));

    // pick por slot (diversidade)
    function pickForSlot(slotIdx, list, chosenUrls) {
      const want = slots[slotIdx].want;
      const candidates = list.filter((p) => !chosenUrls.has(p.onde_comprar));
      const preferred = candidates.filter((p) => want.has(p._type)).sort((a, b) => b._score - a._score);
      return preferred[0] || candidates[0] || null;
    }

    const chosenUrls = new Set();
    const chosen = [];

    for (let i = 0; i < 5; i++) {
      const p = pickForSlot(i, ranked, chosenUrls);
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
      if (n.includes("spf") || n.includes("fps") || n.includes("solar")) b.push("Ajuda a proteger a pele diariamente");
      if (n.includes("hidrat") || n.includes("moist")) b.push("Hidratação para conforto e viço");
      if (n.includes("vitamina c") || n.includes("vitamin")) b.push("Auxilia no brilho e uniformização");
      if (n.includes("niacin")) b.push("Ajuda na oleosidade e aparência de poros");
      if (n.includes("acido") || n.includes("ácido")) b.push("Ativo para textura e manchas (use com orientação)");
      if (n.includes("micelar") || n.includes("clean") || n.includes("limp")) b.push("Limpeza para remover resíduos do dia");
      if (b.length === 0) b.push("Combina com seu perfil e rotina facial");
      return b.slice(0, 4);
    }

    const top5 = chosen.slice(0, 5).map((p, i) => ({
      id: ("opaque-face-" + Buffer.from(p.onde_comprar).toString("base64")).replace(/=+$/, ""),
      nome: p.nome,
      marca: p.marca || "Opaque",
      preco: p.preco && p.preco > 0 ? toBRL(p.preco) : toBRL(Math.max(49.9, BUDGET_MIN || 49.9)),
      foto: isHttps(p.foto) ? p.foto : FACE_FALLBACK_IMGS[i % FACE_FALLBACK_IMGS.length],
      beneficios: makeBenefits(p),
      motivo: "Selecionado para montar uma rotina completa (limpeza, hidratação, proteção, renovação e tratamento) respeitando seu perfil e orçamento.",
      onde_comprar: p.onde_comprar
    }));

    // fallback raro: se não achou 5, completa com a categoria FACE (não outlet)
    while (top5.length < 5) {
      top5.push({
        id: "opaque-face-cat-" + (top5.length + 1),
        nome: "Ver opções em Tratamento Facial (Opaque)",
        marca: "Opaque",
        preco: toBRL(Math.max(49.9, BUDGET_MIN || 49.9)),
        foto: FACE_FALLBACK_IMGS[top5.length % FACE_FALLBACK_IMGS.length],
        beneficios: ["Veja opções de tratamento facial disponíveis"],
        motivo: "Não encontramos 5 itens ideais no momento; veja mais opções na categoria.",
        onde_comprar: `${BASE}/tratamento/face`
      });
    }

    return res.json({ products: top5.slice(0, 5) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Falha ao gerar produtos (OPAQUE FACE)" });
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
