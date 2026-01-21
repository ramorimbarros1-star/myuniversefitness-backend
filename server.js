// server.js (CommonJS) — Produção: Busca MeuCabeloNatural + PIX (FAKE opcional) + Proxy Imagens + Leads (Google Sheets)
// v3: melhora orçamento (se não achar na faixa alta, desce para faixas abaixo) + evita fallback genérico de busca
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const cheerio = require("cheerio");

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
      // permite curl/postman/servidor (sem origin)
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

// OpenAI
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

// ===================== Geração: Busca no MeuCabeloNatural =====================
app.post("/api/generate-products", async (req, res) => {
  try {
    const { answers } = req.body || {};
    if (!answers) return res.status(400).json({ error: "answers ausente" });

    const BASE = "https://www.meucabelonatural.com.br";
    const SEARCH_URL = (q) => `${BASE}/catalogsearch/result/?q=${encodeURIComponent(q)}`;

    // Imagens fallback (capilares)
    const HAIR_FALLBACK_IMGS = [
      "https://images.pexels.com/photos/3992872/pexels-photo-3992872.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/3993449/pexels-photo-3993449.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/8534274/pexels-photo-8534274.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/3992871/pexels-photo-3992871.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/3993446/pexels-photo-3993446.jpeg?auto=compress&cs=tinysrgb&w=800",
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

    const HAIR_KEYWORDS = [
      "shampoo",
      "condicionador",
      "máscara",
      "mascara",
      "leave-in",
      "leave in",
      "tônico",
      "tonico",
      "óleo",
      "oleo",
      "ampola",
      "protetor térmico",
      "protetor termico",
      "finalizador",
      "sérum",
      "serum",
      "loção capilar",
      "locao capilar",
      "spray capilar",
      "esfoliante capilar",
      "anticaspa",
      "antioleosidade",
      "antifrizz",
      "reparador de pontas",
      "umect",
      "hidrata",
      "nutri",
      "reconstr",
      "ativador de cachos",
      "creme para pentear",
      "gelatina",
      "gel",
      "cachos",
      "cache",
    ];

    const toBRL = (v) => Math.round(Number(v) * 100) / 100;

    const isHttps = (u) => {
      try {
        return new URL(u).protocol === "https:";
      } catch {
        return false;
      }
    };

    function parseBudgetRange(txt) {
      const t = (txt || "").toLowerCase();
      if (t.includes("até r$ 80") || t.includes("ate r$ 80") || t.includes("até 80") || t.includes("ate 80"))
        return [0, 80];
      if (t.includes("81") || t.includes("r$ 81") || t.includes("81 - 150")) return [81, 150];
      if (t.includes("151") || t.includes("r$ 151") || t.includes("151 - 250")) return [151, 250];
      if (t.includes("251") || t.includes("r$ 251")) return [251, 9999];
      return [0, 9999];
    }

    function isForbidden(name) {
      const n = (name || "").toLowerCase();
      return FORBIDDEN_TERMS.some((t) => n.includes(t));
    }

    function isHairCategory(name) {
      const n = (name || "").toLowerCase();
      return HAIR_KEYWORDS.some((k) => n.includes(k));
    }

    function inBudget(price, min, max) {
      return Number.isFinite(price) && price >= min && price <= max;
    }

    function absoluteUrl(u) {
      if (!u) return "";
      if (/^https?:\/\//i.test(u)) return u;
      if (u.startsWith("/")) return BASE + u;
      return BASE + "/" + u;
    }

    function parseBRL(txt) {
      if (!txt) return 0;
      const t = txt.replace(/\s+/g, " ").trim();

      // Formato BR: R$ 123,45
      const m = t.match(/R\$\s*([\d.]+,\d{2})/);
      if (m) return Number(m[1].replace(/\./g, "").replace(",", "."));

      // Formato alternativo
      const m2 = t.match(/R\$\s*([\d.]+\.\d{2})/);
      if (m2) return Number(m2[1].replace(/\./g, ""));

      return 0;
    }

    function extractBrandFromName(name) {
      const known = [
        "Widi Care",
        "Yenzah",
        "Lola",
        "Inoar",
        "Salon Line",
        "Haskell",
        "Bio Extratus",
        "Skala",
        "Truss",
        "Cadiveu",
        "Keune",
        "Redken",
        "Kérastase",
        "Kerastase",
        "Acquaflora",
        "Amend",
        "Eico",
        "Forever Liss",
        "Dabelle",
        "Dabur",
      ];
      const hit = known.find((b) => name.toLowerCase().includes(b.toLowerCase()));
      return hit || "";
    }

    function classifyType(name) {
      const n = (name || "").toLowerCase();
      const has = (arr) => arr.some((k) => n.includes(k));
      if (has(["shampoo", "anticaspa", "antioleosidade"])) return "shampoo";
      if (has(["condicionador"])) return "condicionador";
      if (has(["máscara", "mascara", "tratamento", "hidrata", "nutri", "reconstr", "umect"])) return "mask";
      if (has(["tônico", "tonico", "loção capilar", "locao capilar"])) return "tonic";
      if (has(["leave-in", "leave in", "creme para pentear", "ativador de cachos", "gelatina", "finalizador"]))
        return "leavein";
      if (has(["óleo", "oleo", "reparador de pontas", "sérum", "serum"])) return "oil";
      if (has(["protetor térmico", "protetor termico"])) return "heat";
      return "other";
    }

    function pickImgFromElement($, root) {
      const imgEl =
        root.find("img.product-image-photo").first().length
          ? root.find("img.product-image-photo").first()
          : root.find("img").first();

      if (!imgEl || !imgEl.length) return "";

      let src =
        imgEl.attr("src") ||
        imgEl.attr("data-src") ||
        imgEl.attr("data-original") ||
        imgEl.attr("data-lazy") ||
        "";

      if (!src) {
        const srcset = imgEl.attr("srcset") || "";
        if (srcset) src = srcset.split(",")[0].trim().split(" ")[0].trim();
      }
      return src || "";
    }

    function parseProductsFromHTML(html) {
      const $ = cheerio.load(html);
      const items = [];

      $(".product-item").each((_, el) => {
        const root = $(el);

        const a = root.find("a.product-item-link").first();
        const name = (a.text() || "").trim();
        const href = a.attr("href") || "";

        let img = pickImgFromElement($, root);
        img = absoluteUrl(img);

        const priceText =
          root.find(".price").first().text().trim() ||
          root.find("[data-price-type]").first().text().trim() ||
          "";
        const price = parseBRL(priceText);

        const stockText = root.text().toLowerCase();
        const outOfStock = stockText.includes("fora de estoque");

        if (!name || !href) return;

        items.push({
          nome: name,
          marca: extractBrandFromName(name) || "Meu Cabelo Natural",
          preco: toBRL(price || 0),
          foto: img,
          onde_comprar: absoluteUrl(href),
          _out: outOfStock,
          _type: classifyType(name),
        });
      });

      return items;
    }

    async function mcnSearch(query) {
      const url = SEARCH_URL(query);
      const r = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: { "user-agent": "Mozilla/5.0", accept: "text/html,application/xhtml+xml" },
      });
      if (!r.ok) return [];
      const html = await r.text();
      return parseProductsFromHTML(html);
    }

    function buildQuery(cat, answers) {
      const parts = [cat];

      if (answers?.tipo) parts.push(`cabelo ${answers.tipo.toLowerCase()}`);

      if (answers?.couro) {
        const c = answers.couro.toLowerCase();
        if (c.includes("oleoso")) parts.push("oleoso");
        if (c.includes("seco")) parts.push("seco");
        if (c.includes("sens")) parts.push("sensivel");
      }

      if (answers?.quimica && answers.quimica !== "Nenhuma") {
        const q = answers.quimica.toLowerCase();
        if (q.includes("alis")) parts.push("pos-quimica");
        if (q.includes("color") || q.includes("luzes") || q.includes("mechas")) parts.push("cabelos coloridos");
      }

      if (answers?.calor && answers.calor !== "Nunca") parts.push("protecao termica");
      if (answers?.fragrancia && answers.fragrancia !== "Neutra") parts.push(answers.fragrancia.toLowerCase());

      return parts.join(" ");
    }

    function desiredMix(answers) {
      const inc = answers?.inc || [];
      const wantsAntiOil = inc.includes("Oleosidade");
      const wantsDandruff = inc.includes("Caspa");
      const wantsHairLoss = inc.includes("Queda");
      const wantsFrizz = inc.includes("Frizz");
      const wantsSplit = inc.includes("Pontas duplas");
      const wantsDry = inc.includes("Ressecamento");

      let first = "shampoo";
      if (wantsDandruff) first = "shampoo anticaspa";
      else if (wantsAntiOil) first = "shampoo antioleosidade";

      let second = "mascara hidratante";
      if (wantsDry) second = "mascara hidratante";
      else if (answers?.quimica && answers.quimica !== "Nenhuma") second = "mascara reconstrucao";
      else second = "mascara nutricao";

      let third = "leave-in";
      if (wantsFrizz) third = "leave-in antifrizz";
      else if (wantsSplit) third = "oleo reparador";
      else if (wantsHairLoss) third = "tonico capilar";
      else third = "finalizador";

      return [first, second, third];
    }

    const [BUDGET_MIN, BUDGET_MAX] = parseBudgetRange(answers?.orcamento);

    function scoreProduct(p, answers, catText) {
      let s = 0;
      const name = (p.nome || "").toLowerCase();

      if (isForbidden(name)) return -Infinity;
      if (!isHairCategory(name)) s -= 6;
      if (p._out) s -= 10;

      if (catText) {
        for (const kw of catText.split(/\s+/)) {
          if (kw && name.includes(kw.toLowerCase())) s += 1.5;
        }
      }

      if (answers?.tipo && name.includes(answers.tipo.toLowerCase())) s += 1.25;

      for (const inc of answers?.inc || []) {
        const k = (inc || "").toLowerCase();
        if (k && name.includes(k)) s += 1.0;
      }

      // orçamento: não elimina, mas penaliza fora da faixa
      if (p.preco > 0) {
        if (inBudget(p.preco, BUDGET_MIN, BUDGET_MAX)) s += 2.5;
        else s -= 3.5;
      } else {
        s -= 0.75;
      }

      if (p.onde_comprar && p.onde_comprar.startsWith(BASE + "/")) s += 0.75;
      if (p.foto && isHttps(p.foto)) s += 0.5;
      if (p.marca) s += 0.25;

      return s;
    }

    const mix = desiredMix(answers);
    const queries = mix.map((cat) => buildQuery(cat, answers));

    const results = [];
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      let lst = await mcnSearch(q);

      lst = lst
        .filter((p) => p && p.nome && p.onde_comprar)
        .filter((p) => !isForbidden(p.nome))
        .filter((p) => isHairCategory(p.nome));

      lst.forEach((p) =>
        results.push({
          ...p,
          _score: scoreProduct(p, answers, mix[i]),
        })
      );
    }

    // ===================== NOVA LÓGICA DE ORÇAMENTO (desce faixas se não achar na alta) =====================
    // 1) tenta respeitar a faixa (min..max)
    const strict = results.filter(
      (p) =>
        p._score > -Infinity &&
        (p.preco > 0 ? inBudget(p.preco, BUDGET_MIN, BUDGET_MAX) : true)
    );

    let pool = strict;

    // 2) se não tiver opções suficientes, amplia a faixa em ±20%
    if (pool.length < 9) {
      const widenMin = Math.max(0, Math.floor(BUDGET_MIN * 0.8));
      const widenMax = Math.ceil(BUDGET_MAX * 1.2);

      pool = results.filter(
        (p) =>
          p._score > -Infinity &&
          (p.preco > 0 ? inBudget(p.preco, widenMin, widenMax) : true)
      );
    }

    // 3) ✅ se ainda não tiver o suficiente, aceita preços ABAIXO do mínimo (0..max)
    //    (resolve: faixas 151-250 e 251+ trazendo produtos das faixas abaixo)
    if (pool.length < 3) {
      pool = results.filter(
        (p) =>
          p._score > -Infinity &&
          (p.preco > 0 ? p.preco <= BUDGET_MAX : true)
      );
    }

    // 4) última proteção: se mesmo assim estiver baixo, remove filtro de preço
    if (pool.length < 3) {
      pool = results.filter((p) => p._score > -Infinity);
    }

    // ordena e remove duplicatas
    const seen = new Set();
    const ranked = pool
      .sort((a, b) => b._score - a._score)
      .filter((p) => p.onde_comprar && p.onde_comprar.startsWith(BASE + "/"))
      .filter((p) => (seen.has(p.onde_comprar) ? false : (seen.add(p.onde_comprar), true)));

    function estimatePriceForSlot(slotIdx) {
      const min = Math.max(19.9, BUDGET_MIN || 0);
      const max = Math.max(min + 10, BUDGET_MAX || 150);
      const candidates = [
        Math.min(max, Math.max(min, 49.9)),
        Math.min(max, Math.max(min, 69.9)),
        Math.min(max, Math.max(min, 89.9)),
      ];
      return toBRL(candidates[slotIdx % candidates.length]);
    }

    // diversidade por “tipo de produto” (shampoo / máscara / finalizador etc)
    const preferredTypesBySlot = [
      new Set(["shampoo", "tonic"]),
      new Set(["mask", "condicionador"]),
      new Set(["leavein", "oil", "heat", "other"]),
    ];

    function pickBestForSlot(list, slotIdx, chosenUrls, chosenBrands) {
      const preferred = preferredTypesBySlot[slotIdx];
      const candidates = list.filter((p) => !chosenUrls.has(p.onde_comprar));

      const bestPreferred = candidates.filter((p) => preferred.has(p._type)).sort((a, b) => b._score - a._score);

      let pick =
        bestPreferred.find((p) => p.marca && !chosenBrands.has(p.marca)) ||
        bestPreferred[0];

      if (!pick) pick = candidates.sort((a, b) => b._score - a._score)[0];
      return pick || null;
    }

    const chosenUrls = new Set();
    const chosenBrands = new Set();
    const chosen = [];

    for (let slot = 0; slot < 3; slot++) {
      const p = pickBestForSlot(ranked, slot, chosenUrls, chosenBrands);
      if (!p) break;
      chosen.push(p);
      chosenUrls.add(p.onde_comprar);
      if (p.marca) chosenBrands.add(p.marca);
    }

    let idx = 0;
    while (chosen.length < 3 && idx < ranked.length) {
      const p = ranked[idx++];
      if (!p) break;
      if (chosenUrls.has(p.onde_comprar)) continue;
      chosen.push(p);
      chosenUrls.add(p.onde_comprar);
      if (p.marca) chosenBrands.add(p.marca);
    }

    const top3 = chosen.slice(0, 3).map((p, i) => {
      const foto = isHttps(p.foto) ? p.foto : HAIR_FALLBACK_IMGS[i % HAIR_FALLBACK_IMGS.length];
      const preco = p.preco && p.preco > 0 ? toBRL(p.preco) : estimatePriceForSlot(i);

      const beneficios = [];
      const nameLc = (p.nome || "").toLowerCase();
      if (nameLc.includes("oleos")) beneficios.push("Ajuda a controlar oleosidade");
      if (nameLc.includes("hidr") || nameLc.includes("nutri")) beneficios.push("Hidratação / nutrição");
      if (nameLc.includes("frizz")) beneficios.push("Redução de frizz");
      if (nameLc.includes("brilho")) beneficios.push("Mais brilho");
      if (nameLc.includes("anticaspa")) beneficios.push("Ação anticaspa");
      if (nameLc.includes("reconstr") || nameLc.includes("danific")) beneficios.push("Reconstrução para fios danificados");
      if (nameLc.includes("cachos") || nameLc.includes("cache")) beneficios.push("Definição e tratamento para ondas/cachos");
      if (beneficios.length === 0) beneficios.push("Cuidado capilar coerente ao seu perfil");

      const motivo =
        "Selecionado para equilibrar sua rotina (limpeza, tratamento e finalização), respeitando seu perfil e orçamento.";

      return {
        id: ("mcn-" + Buffer.from(p.onde_comprar).toString("base64")).replace(/=+$/, ""),
        nome: p.nome,
        marca: p.marca || "Meu Cabelo Natural",
        preco,
        foto,
        beneficios: beneficios.slice(0, 4),
        motivo,
        onde_comprar: p.onde_comprar,
      };
    });

    // ===================== Completar com itens reais antes de usar busca genérica =====================
    let cursor = 0;
    while (top3.length < 3 && cursor < ranked.length) {
      const p = ranked[cursor++];
      if (!p || !p.onde_comprar) continue;

      // evita duplicar
      if (top3.some((x) => x.onde_comprar === p.onde_comprar)) continue;

      top3.push({
        id: ("mcn-extra-" + Buffer.from(p.onde_comprar).toString("base64")).replace(/=+$/, ""),
        nome: p.nome || "Produto capilar",
        marca: p.marca || "Meu Cabelo Natural",
        preco: (p.preco && p.preco > 0) ? toBRL(p.preco) : toBRL(Math.max(49.9, BUDGET_MIN || 49.9)),
        foto: isHttps(p.foto) ? p.foto : HAIR_FALLBACK_IMGS[top3.length % HAIR_FALLBACK_IMGS.length],
        beneficios: ["Cuidado capilar coerente ao seu perfil"],
        motivo: "Opção adicional para completar sua rotina respeitando disponibilidade e orçamento.",
        onde_comprar: p.onde_comprar
      });
    }

    // se mesmo assim não tiver, usa busca (raro)
    while (top3.length < 3) {
      top3.push({
        id: "mcn-busca-" + (top3.length + 1),
        nome: "Sugestão capilar (busca)",
        marca: "Meu Cabelo Natural",
        preco: toBRL(Math.max(49.9, BUDGET_MIN || 49.9)),
        foto: HAIR_FALLBACK_IMGS[top3.length % HAIR_FALLBACK_IMGS.length],
        beneficios: ["Veja mais opções no site"],
        motivo: "Não encontramos 3 itens ideais no momento; veja opções disponíveis.",
        onde_comprar: SEARCH_URL("shampoo")
      });
    }

    res.json({ products: top3.slice(0, 3) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Falha ao gerar produtos (MCN)" });
  }
});

// ===================== PIX: criar cobrança (FAKE ou REAL) =====================
app.post("/api/create-pix", async (req, res) => {
  try {
    const body = req.body || {};
    const amount = body.amount != null ? body.amount : 4.99;
    const description = body.description || "Desbloqueio recomendações capilares";
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

    // ✅ Fix: evita gerar "data:image/png;base64," vazio
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
