// server.js (CommonJS) — Produção: Busca OPAQUE (Outlet) + PIX (FAKE opcional) + Proxy Imagens + Leads (Google Sheets)
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

// OpenAI (não é obrigatório para essa busca, mas deixo para compatibilidade)
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

// ===================== Geração: Busca na OPAQUE (Outlet) =====================
app.post("/api/generate-products", async (req, res) => {
  try {
    const { answers } = req.body || {};
    if (!answers) return res.status(400).json({ error: "answers ausente" });

    const BASE = "https://www.opaque.com.br";

    // ✅ endpoint VTEX (JSON) — mais estável que scraping HTML
    // ft = termo buscado, O = ordenação (melhor desconto), _from/_to = paginação
    const SEARCH_API = (q) =>
      `${BASE}/api/catalog_system/pub/products/search/?ft=${encodeURIComponent(q)}&O=OrderByBestDiscountDESC&_from=0&_to=24`;

    // Fallbacks (imagem de maquiagem) caso a imagem do produto falhe
    const MAKEUP_FALLBACK_IMGS = [
      "https://images.pexels.com/photos/3373724/pexels-photo-3373724.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/2688992/pexels-photo-2688992.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/2533266/pexels-photo-2533266.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/2693644/pexels-photo-2693644.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/3785784/pexels-photo-3785784.jpeg?auto=compress&cs=tinysrgb&w=800",
    ];

    const FORBIDDEN_TERMS = [
      "infantil","infantis","baby","bebê","bebe","crianca","criança","kids","menino","menina","pediátric","pediatric","júnior","junior"
    ];

    // Palavras-chave “maquiagem” (para evitar retornar perfume/tratamento etc)
    const MAKEUP_KEYWORDS = [
      "base","corretivo","pó","po","blush","bronzer","iluminador","primer","fixador","bruma",
      "máscara","mascara","cílios","cilios","rímel","rimel","delineador","lápis","lapis",
      "sombra","paleta","batom","gloss","boca","contorno","sobrancelha","pincel","esponja",
      "bb cream","cc cream","compacto","líquido","liquido"
    ];

    const toBRL = (v) => Math.round(Number(v) * 100) / 100;

    const isHttps = (u) => {
      try { return new URL(u).protocol === "https:"; } catch { return false; }
    };

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

    function isMakeupCategory(name) {
      const n = (name || "").toLowerCase();
      return MAKEUP_KEYWORDS.some((k) => n.includes(k));
    }

    function inBudget(price, min, max) {
      return Number.isFinite(price) && price >= min && price <= max;
    }

    function classifyType(name) {
      const n = (name || "").toLowerCase();
      const has = (arr) => arr.some((k) => n.includes(k));
      if (has(["base","bb cream","cc cream"])) return "base";
      if (has(["corretivo"])) return "concealer";
      if (has(["pó","po","compacto"])) return "powder";
      if (has(["primer"])) return "primer";
      if (has(["fixador","bruma"])) return "setting";
      if (has(["blush","bronzer","iluminador"])) return "face";
      if (has(["máscara","mascara","cilios","cílios","rimel","rímel","delineador","sombra","paleta"])) return "eyes";
      if (has(["batom","gloss","boca"])) return "lips";
      return "other";
    }

    function normalizeOpaqueProduct(p) {
      // Estrutura típica VTEX:
      // productName, brand, linkText, items[0].images[0].imageUrl, sellers[0].commertialOffer.Price/AvailableQuantity
      const name = p?.productName || "";
      const brand = p?.brand || "Opaque";
      const linkText = p?.linkText || "";
      const url = p?.link || (linkText ? `${BASE}/${linkText}/p` : "");
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
        onde_comprar: url,
        _out: available === 0,
        _type: classifyType(name),
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
        .map(normalizeOpaqueProduct)
        .filter((x) => x && x.nome && x.onde_comprar);
    }

    // --------- Monta as 3 buscas com base nas respostas ----------
    const pele = (answers?.pele || "").toLowerCase();
    const acabamento = (answers?.acabamento || "").toLowerCase();
    const cobertura = (answers?.cobertura || "").toLowerCase();
    const inc = Array.isArray(answers?.inc) ? answers.inc : [];

    function buildQuery(cat) {
      const parts = [cat];

      if (pele.includes("oleos")) parts.push("pele oleosa");
      if (pele.includes("seca")) parts.push("pele seca");
      if (pele.includes("sens")) parts.push("pele sensível");

      if (acabamento.includes("matte")) parts.push("matte");
      if (acabamento.includes("glow")) parts.push("iluminado");
      if (acabamento.includes("natural")) parts.push("natural");

      if (cobertura.includes("leve")) parts.push("leve");
      if (cobertura.includes("média") || cobertura.includes("media")) parts.push("média");
      if (cobertura.includes("alta")) parts.push("alta cobertura");

      // objetivos/incômodos
      const incTxt = inc.join(" ").toLowerCase();
      if (incTxt.includes("oleos")) parts.push("controle de oleosidade");
      if (incTxt.includes("poros")) parts.push("poros");
      if (incTxt.includes("acne")) parts.push("acne");
      if (incTxt.includes("manchas")) parts.push("manchas");
      if (incTxt.includes("olheiras")) parts.push("olheiras");
      if (incTxt.includes("derrete") || incTxt.includes("fixação")) parts.push("longa duração");

      return parts.join(" ");
    }

    // mix pensado para maquiagem diária (diversidade)
    // slot1: pele (base/primer/corretivo), slot2: olhos, slot3: lábios/fixação
    const mix = ["base", "máscara de cílios", "batom"];
    const queries = mix.map((cat) => buildQuery(cat));

    const [BUDGET_MIN, BUDGET_MAX] = parseBudgetRange(answers?.orcamento);

    function scoreProduct(p, catText) {
      let s = 0;
      const name = (p.nome || "").toLowerCase();

      if (isForbidden(name)) return -Infinity;
      if (p._out) s -= 10;

      // tem que ser maquiagem (senão penaliza forte)
      if (!isMakeupCategory(name)) s -= 8;
      else s += 2;

      // encaixe com a “categoria” do slot
      if (catText) {
        const c = catText.toLowerCase();
        if (name.includes(c.split(" ")[0])) s += 2.2;
      }

      // orçamento: não elimina, mas puxa para dentro
      if (p.preco > 0) {
        if (inBudget(p.preco, BUDGET_MIN, BUDGET_MAX)) s += 2.8;
        else s -= 3.2;
      } else {
        s -= 0.75;
      }

      // link e imagem
      if (p.onde_comprar && p.onde_comprar.startsWith(BASE + "/")) s += 0.7;
      if (p.foto && isHttps(p.foto)) s += 0.6;
      if (p.marca) s += 0.25;

      // acabamento
      if ((answers?.acabamento || "").toLowerCase().includes("matte") && name.includes("matte")) s += 1.2;
      if ((answers?.acabamento || "").toLowerCase().includes("glow") && (name.includes("glow") || name.includes("ilumin"))) s += 1.2;

      // longa duração
      const incTxt = (inc || []).join(" ").toLowerCase();
      if ((incTxt.includes("derrete") || incTxt.includes("fixa")) && (name.includes("longa") || name.includes("fix") || name.includes("24h"))) s += 1.2;

      return s;
    }

    const results = [];
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      let lst = await opaqueSearch(q);

      lst = lst
        .filter((p) => !isForbidden(p.nome))
        .filter((p) => p.onde_comprar && p.onde_comprar.startsWith(BASE + "/"));

      lst.forEach((p) =>
        results.push({ ...p, _score: scoreProduct(p, mix[i]) })
      );
    }

    // ===================== Lógica de orçamento (desce faixas se necessário) =====================
    // 1) tenta faixa exata
    const strict = results.filter((p) => p._score > -Infinity && (p.preco > 0 ? inBudget(p.preco, BUDGET_MIN, BUDGET_MAX) : true));
    let pool = strict;

    // 2) amplia ±20%
    if (pool.length < 9) {
      const widenMin = Math.max(0, Math.floor(BUDGET_MIN * 0.8));
      const widenMax = Math.ceil(BUDGET_MAX * 1.2);
      pool = results.filter((p) => p._score > -Infinity && (p.preco > 0 ? inBudget(p.preco, widenMin, widenMax) : true));
    }

    // 3) se ainda faltar, aceita abaixo do máximo (resolve faixa alta sem produto)
    if (pool.length < 3) {
      pool = results.filter((p) => p._score > -Infinity && (p.preco > 0 ? p.preco <= BUDGET_MAX : true));
    }

    // 4) último fallback: remove filtro de preço
    if (pool.length < 3) {
      pool = results.filter((p) => p._score > -Infinity);
    }

    // ordena e remove duplicatas por URL
    const seen = new Set();
    const ranked = pool
      .sort((a, b) => b._score - a._score)
      .filter((p) => (seen.has(p.onde_comprar) ? false : (seen.add(p.onde_comprar), true)));

    // diversidade por “tipo de produto”
    const preferredTypesBySlot = [
      new Set(["base", "primer", "concealer", "powder"]),
      new Set(["eyes"]),
      new Set(["lips", "setting", "face", "other"]),
    ];

    function pickBestForSlot(list, slotIdx, chosenUrls) {
      const preferred = preferredTypesBySlot[slotIdx];
      const candidates = list.filter((p) => !chosenUrls.has(p.onde_comprar));
      const bestPreferred = candidates.filter((p) => preferred.has(p._type)).sort((a, b) => b._score - a._score);
      return bestPreferred[0] || candidates.sort((a, b) => b._score - a._score)[0] || null;
    }

    const chosenUrls = new Set();
    const chosen = [];

    for (let slot = 0; slot < 3; slot++) {
      const p = pickBestForSlot(ranked, slot, chosenUrls);
      if (!p) break;
      chosen.push(p);
      chosenUrls.add(p.onde_comprar);
    }

    // completa se faltou
    let idx = 0;
    while (chosen.length < 3 && idx < ranked.length) {
      const p = ranked[idx++];
      if (!p) break;
      if (chosenUrls.has(p.onde_comprar)) continue;
      chosen.push(p);
      chosenUrls.add(p.onde_comprar);
    }

    function makeBenefits(p) {
      const n = (p.nome || "").toLowerCase();
      const b = [];
      if (n.includes("matte")) b.push("Ajuda a controlar brilho (efeito matte)");
      if (n.includes("hidrat") || n.includes("glow") || n.includes("ilumin")) b.push("Acabamento mais bonito na pele");
      if (n.includes("longa") || n.includes("24h") || n.includes("fix")) b.push("Maior fixação ao longo do dia");
      if (n.includes("poros")) b.push("Efeito de disfarce de poros");
      if (n.includes("corretivo") || n.includes("concealer")) b.push("Ajuda a uniformizar e cobrir imperfeições");
      if (b.length === 0) b.push("Combina com seu perfil e rotina de maquiagem");
      return b.slice(0, 4);
    }

    const top3 = chosen.slice(0, 3).map((p, i) => {
      const foto = isHttps(p.foto) ? p.foto : MAKEUP_FALLBACK_IMGS[i % MAKEUP_FALLBACK_IMGS.length];
      const preco = p.preco && p.preco > 0 ? toBRL(p.preco) : toBRL(Math.max(49.9, BUDGET_MIN || 49.9));

      return {
        id: ("opaque-" + Buffer.from(p.onde_comprar).toString("base64")).replace(/=+$/, ""),
        nome: p.nome,
        marca: p.marca || "Opaque",
        preco,
        foto,
        beneficios: makeBenefits(p),
        motivo: "Selecionado para equilibrar sua rotina (pele, olhos e finalização), respeitando seu perfil e orçamento.",
        onde_comprar: p.onde_comprar,
      };
    });

    // fallback final (muito raro): se ainda faltou, cria itens apontando para OUTLET
    while (top3.length < 3) {
      top3.push({
        id: "opaque-outlet-" + (top3.length + 1),
        nome: "Sugestão no Outlet Opaque",
        marca: "Opaque",
        preco: toBRL(Math.max(49.9, BUDGET_MIN || 49.9)),
        foto: MAKEUP_FALLBACK_IMGS[top3.length % MAKEUP_FALLBACK_IMGS.length],
        beneficios: ["Veja opções com desconto no Outlet"],
        motivo: "Não encontramos 3 itens ideais no momento; veja as opções disponíveis com desconto.",
        onde_comprar: `${BASE}/outlet?O=OrderByBestDiscountDESC`,
      });
    }

    return res.json({ products: top3.slice(0, 3) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Falha ao gerar produtos (OPAQUE)" });
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
