// server.js (CommonJS) — OPAQUE (Face) + PIX (FAKE opcional) + Proxy Imagens + Leads (Google Sheets)
// vBudgetStepUp: se não achar produtos na faixa, sobe para a próxima faixa e AVISA via mensagem.
// Também evita fallback de categoria (sempre tenta retornar produtos reais).

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

    const BASE = "https://www.opaque.com.br";

    // ===== Rakuten afiliado =====
    const RAKUTEN_PARAMS = {
      utm_source: "rakuten",
      utm_medium: "afiliados",
      utm_term: "4587713",
      ranMID: "47714",
      ranEAID: "OyPY4YHfHl4",
      ranSiteID: "OyPY4YHfHl4-5t9np1DoTPuG6fO28twrDA",
    };

    function addRakutenAffiliate(url) {
      try {
        if (!url) return url;
        const u = new URL(url);
        if (!u.hostname.endsWith("opaque.com.br")) return url;
        Object.entries(RAKUTEN_PARAMS).forEach(([k, v]) => u.searchParams.set(k, v));
        return u.toString();
      } catch {
        return url;
      }
    }

    // VTEX Search API (pega mais itens)
    const SEARCH_API = (q, from = 0, to = 99) =>
      `${BASE}/api/catalog_system/pub/products/search/?ft=${encodeURIComponent(q)}&O=OrderByBestDiscountDESC&_from=${from}&_to=${to}`;

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
    function inRange(price, min, max) {
      return Number.isFinite(price) && price > 0 && price >= min && price <= max;
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

    function buildProductUrlFromVtex(p) {
      const linkText = p?.linkText || "";
      if (linkText) return `${BASE}/${linkText}/p`;
      const link = p?.link || "";
      if (link && link.startsWith("http")) return link;
      return "";
    }

    function getOfferInfo(p) {
      const item = Array.isArray(p?.items) ? p.items[0] : null;
      const seller = Array.isArray(item?.sellers) ? item.sellers[0] : null;
      const offer = seller?.commertialOffer || {};
      return { item, seller, offer };
    }

    function normalizeOpaqueProduct(p) {
      const name = p?.productName || "";
      const brand = p?.brand || "Opaque";

      const urlRaw = buildProductUrlFromVtex(p);
      const url = addRakutenAffiliate(urlRaw);

      const { item, offer } = getOfferInfo(p);

      const img = item?.images?.[0]?.imageUrl || "";
      const price = Number(offer?.Price || offer?.spotPrice || 0);

      const isAvailFlag = typeof offer?.IsAvailable === "boolean" ? offer.IsAvailable : null;
      const qty = Number.isFinite(Number(offer?.AvailableQuantity)) ? Number(offer.AvailableQuantity) : null;

      const out =
        (isAvailFlag === false) ||
        (qty !== null && qty <= 0);

      return {
        nome: name,
        marca: brand,
        foto: img,
        preco: toBRL(price || 0),
        onde_comprar: url,
        _out: out,
        _type: classifyType(name),
      };
    }

    async function opaqueSearch(query) {
      const url = SEARCH_API(query, 0, 99);

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
        .filter((x) => x && x.nome && x.onde_comprar && x.onde_comprar.includes("opaque.com.br/"));
    }

    // ====== Faixas de preço (em ordem) ======
    // Se não encontrar na faixa do usuário, sobe para a próxima(s).
    const BUDGET_TIERS = [
      { label: "Até R$ 60", min: 0, max: 60 },
      { label: "R$ 61 - R$ 90", min: 61, max: 90 },
      { label: "R$ 91 - R$ 120", min: 91, max: 120 },
      { label: "R$ 121 - R$ 150", min: 121, max: 150 },
      { label: "R$ 151 - R$ 200", min: 151, max: 200 },
      { label: "R$ 201 - R$ 250", min: 201, max: 250 },
      { label: "R$ 251 - R$ 350", min: 251, max: 350 },
      { label: "R$ 351+", min: 351, max: 9999 },
    ];

    function detectTierIndex(txt) {
      const t = (txt || "").toLowerCase();

      if (t.includes("até r$ 60") || t.includes("ate r$ 60") || t.includes("até 60") || t.includes("ate 60")) return 0;

      if (t.includes("61") && t.includes("90")) return 1;
      if (t.includes("91") && t.includes("120")) return 2;
      if (t.includes("121") && t.includes("150")) return 3;
      if (t.includes("151") && t.includes("200")) return 4;
      if (t.includes("201") && t.includes("250")) return 5;
      if (t.includes("251") && t.includes("350")) return 6;
      if (t.includes("351") || t.includes("acima") || t.includes("+")) return 7;

      // compat antigo
      if (t.includes("até r$ 80") || t.includes("ate r$ 80") || t.includes("até 80") || t.includes("ate 80")) return 1; // joga pra perto
      if (t.includes("81") && t.includes("150")) return 3;
      if (t.includes("151") && t.includes("250")) return 5;
      if (t.includes("251")) return 7;

      return 0;
    }

    // ===== Respostas do questionário (skin care) =====
    const pele = (answers?.pele || "").toLowerCase();
    const sensibilidade = (answers?.sensibilidade || "").toLowerCase();
    const inc = Array.isArray(answers?.inc) ? answers.inc : [];
    const incTxt = inc.join(" ").toLowerCase();

    function buildQueryBase(cat) {
      const parts = [cat, "facial"];

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

    function slotQueries(cat) {
      const q1 = buildQueryBase(cat);
      const q2 = `${cat} facial`;
      const q3 = `${cat} face`;
      const q4 = cat;
      const q5 = `tratamento facial ${cat}`;
      return [q1, q2, q3, q5, q4];
    }

    // 5 slots fixos (rotina facial)
    const mix = ["limpador", "hidratante", "protetor solar", "serum", "esfoliante"];

    function scoreProduct(p, catText) {
      const name = (p.nome || "").toLowerCase();

      if (isForbidden(name)) return -Infinity;
      if (p._out) return -Infinity;

      let s = 0;

      if (!isFaceCategory(name)) s -= 10;
      else s += 2.5;

      if (catText) {
        const token = catText.toLowerCase().trim();
        if (token && name.includes(token)) s += 2.0;
      }

      if (pele.includes("oleos") && (name.includes("oil") || name.includes("oleos") || name.includes("controle"))) s += 1.1;
      if (pele.includes("seca") && (name.includes("hidrat") || name.includes("hialur") || name.includes("nutri"))) s += 1.1;
      if (incTxt.includes("acne") && (name.includes("acne") || name.includes("salic"))) s += 1.1;
      if (incTxt.includes("manchas") && (name.includes("vitamina c") || name.includes("niacin") || name.includes("clare"))) s += 0.9;
      if ((pele.includes("sens") || sensibilidade.includes("sim")) && (name.includes("sens") || name.includes("suave") || name.includes("calm"))) s += 0.9;

      if (p.preco > 0) s += 1.2;

      if (p.foto && isHttps(p.foto)) s += 0.6;
      if (p.marca) s += 0.2;
      if (p.onde_comprar && p.onde_comprar.includes("opaque.com.br/")) s += 0.6;

      return s;
    }

    // ===== 1) Busca ampla (sem filtrar por orçamento ainda) =====
    // Depois filtramos por faixa/tier (pra poder subir faixa com o mesmo conjunto).
    const allResults = [];
    for (let i = 0; i < mix.length; i++) {
      const cat = mix[i];
      const tries = slotQueries(cat);

      let agg = [];
      for (const q of tries) {
        const lst = await opaqueSearch(q);

        const filtered = lst
          .filter((p) => p && p.nome && p.onde_comprar)
          .filter((p) => !isForbidden(p.nome))
          .filter((p) => !p._out);

        agg.push(...filtered);
        if (agg.length >= 60) break;
      }

      agg.forEach((p) => {
        allResults.push({
          ...p,
          _slot: i,
          _score: scoreProduct(p, cat),
        });
      });
    }

    const valid = allResults.filter((p) => Number.isFinite(p._score) && p._score > -1e9);

    // remove duplicados por URL
    const seenAll = new Set();
    const uniqueRanked = valid
      .sort((a, b) => b._score - a._score)
      .filter((p) => (seenAll.has(p.onde_comprar) ? false : (seenAll.add(p.onde_comprar), true)));

    // ===== 2) Seleciona 5 produtos, subindo faixa se necessário =====
    const preferredTypesBySlot = [
      new Set(["cleanser"]),
      new Set(["moisturizer"]),
      new Set(["sunscreen"]),
      new Set(["serum", "toner"]),
      new Set(["exfoliant"]),
    ];

    function pickBestForSlot(list, slotIdx, chosenUrls) {
      const preferred = preferredTypesBySlot[slotIdx] || new Set();
      const candidates = list.filter((p) => !chosenUrls.has(p.onde_comprar));
      const bestPreferred = candidates
        .filter((p) => preferred.has(p._type))
        .sort((a, b) => b._score - a._score);

      return bestPreferred[0] || candidates.sort((a, b) => b._score - a._score)[0] || null;
    }

    const userTierIdx = detectTierIndex(answers?.orcamento);
    let usedTierIdx = userTierIdx;

    let chosen = [];
    let chosenUrls = new Set();

    function selectFromPool(pool) {
      chosen = [];
      chosenUrls = new Set();

      for (let slot = 0; slot < 5; slot++) {
        const p = pickBestForSlot(pool, slot, chosenUrls);
        if (!p) break;
        chosen.push(p);
        chosenUrls.add(p.onde_comprar);
      }

      // completa com o restante
      let idx = 0;
      while (chosen.length < 5 && idx < pool.length) {
        const p = pool[idx++];
        if (!p) break;
        if (chosenUrls.has(p.onde_comprar)) continue;
        chosen.push(p);
        chosenUrls.add(p.onde_comprar);
      }

      return chosen;
    }

    function poolForTier(tier) {
      // Tier: filtra por preço (se preco=0, descarta — evita “sem preço” atrapalhar o orçamento)
      return uniqueRanked.filter((p) => p.preco > 0 && inRange(p.preco, tier.min, tier.max));
    }

    // Tenta do tier do usuário, depois sobe
    let pool = poolForTier(BUDGET_TIERS[usedTierIdx]);
    selectFromPool(pool);

    while (chosen.length < 5 && usedTierIdx < BUDGET_TIERS.length - 1) {
      usedTierIdx++;
      const nextPool = poolForTier(BUDGET_TIERS[usedTierIdx]);

      // junta com o que já tinha (pra não perder alguns bons no tier anterior),
      // mas agora aceitando a faixa mais alta também
      pool = uniqueRanked.filter(
        (p) => p.preco > 0 && inRange(p.preco, BUDGET_TIERS[userTierIdx].min, BUDGET_TIERS[usedTierIdx].max)
      );

      selectFromPool(pool);
      if (chosen.length >= 5) break;

      // Se mesmo juntando ainda faltou, tenta somente o pool do tier atual (às vezes enche melhor)
      selectFromPool(nextPool);
      if (chosen.length >= 5) break;
    }

    // ✅ Se ainda assim não achou 5, pega os 5 mais baratos disponíveis (sempre produto real)
    if (chosen.length < 5) {
      const cheapest = uniqueRanked
        .filter((p) => p.preco > 0)
        .sort((a, b) => a.preco - b.preco);

      selectFromPool(cheapest);
    }

    // ===== 3) Monta resposta final + mensagem =====
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
      const preco = p.preco && p.preco > 0 ? toBRL(p.preco) : toBRL(49.9);

      return {
        id: ("opaque-" + Buffer.from(p.onde_comprar).toString("base64")).replace(/=+$/, ""),
        nome: p.nome,
        marca: p.marca || "Opaque",
        preco,
        foto,
        beneficios: makeBenefits(p),
        motivo: "Selecionado para montar uma rotina facial completa (limpeza, hidratação, proteção e tratamento), respeitando seu perfil.",
        onde_comprar: addRakutenAffiliate(p.onde_comprar),
      };
    });

    let message = "";
    if (usedTierIdx > userTierIdx) {
      message =
        `Não encontramos produtos suficientes na faixa de preço indicada (${BUDGET_TIERS[userTierIdx].label}). ` +
        `Por isso, exibimos produtos na próxima faixa (${BUDGET_TIERS[usedTierIdx].label}).`;
    }

    return res.json({
      products: top5,
      message,
      budget: {
        chosen: BUDGET_TIERS[userTierIdx],
        used: BUDGET_TIERS[usedTierIdx],
      },
    });
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
