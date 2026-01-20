// server.js (CommonJS) — v3: IA + PIX (FAKE_PIX opcional) + Proxy de Imagens
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const OpenAI = require("openai");
const cheerio = require("cheerio");

// Mercado Pago v2
const mercadopago = require("mercadopago");
const { MercadoPagoConfig, Payment } = mercadopago;

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS
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

// Rate limit
const limiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
app.use(limiter);

// Flags / clientes
const isFakePix = process.env.FAKE_PIX === "1";
let mpClient = null;
if (!isFakePix && process.env.MP_ACCESS_TOKEN) {
  mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
}

// OpenAI (mantido — você pode usar depois para refinar termos/benefícios se quiser)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Health
app.get("/api/health", (req, res) => res.json({ ok: true, fakePix: isFakePix }));

function realToNumber(v) {
  return Math.round(Number(v) * 100) / 100;
}

// ---------------- Geração por BUSCA no Meu Cabelo Natural (com filtros rígidos) ----------------
app.post("/api/generate-products", async (req, res) => {
  try {
    const { answers } = req.body || {};
    if (!answers) return res.status(400).json({ error: "answers ausente" });

    // ===== Config =====
    const BASE = "https://www.meucabelonatural.com.br";
    const SEARCH_URL = (q) => `${BASE}/catalogsearch/result/?q=${encodeURIComponent(q)}`;

    // FALLBACKS 100% capilares
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
    ];

    const toBRL = (v) => Math.round(Number(v) * 100) / 100;

    const isHttps = (u) => {
      try {
        const x = new URL(u);
        return x.protocol === "https:";
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

    function desiredCategories(answers) {
      const inc = answers.inc || [];
      const cats = [];
      if (inc.includes("Oleosidade")) cats.push("shampoo antioleosidade");
      if (inc.includes("Caspa")) cats.push("shampoo anticaspa");
      if (inc.includes("Queda")) cats.push("tonico antiqueda");
      if (inc.includes("Ressecamento")) cats.push("mascara hidratante");
      if (inc.includes("Frizz")) cats.push("leave-in antifrizz");
      if (inc.includes("Pontas duplas")) cats.push("oleo reparador");
      if (inc.includes("Falta de brilho")) cats.push("serum brilho");

      // complemento com rotina base
      if (cats.length === 0) cats.push("shampoo", "mascara hidratante", "leave-in");

      // garante 3 categorias
      const uniq = [...new Set(cats)];
      if (uniq.length < 3) {
        uniq.push("mascara nutricao");
      }
      if (uniq.length < 3) {
        uniq.push("finalizador protecao termica");
      }

      return uniq.slice(0, 4);
    }

    function buildQueryForCategory(cat, answers) {
      const parts = [cat];

      // tipo
      if (answers?.tipo) parts.push(`cabelo ${answers.tipo.toLowerCase()}`);

      // couro cabeludo
      if (answers?.couro) {
        const c = answers.couro.toLowerCase();
        if (c.includes("oleoso")) parts.push("oleoso");
        if (c.includes("seco")) parts.push("seco");
        if (c.includes("sens")) parts.push("sensivel");
      }

      // química
      if (answers?.quimica && answers.quimica !== "Nenhuma") {
        const q = answers.quimica.toLowerCase();
        if (q.includes("alis")) parts.push("pos-quimica");
        if (q.includes("color") || q.includes("luzes") || q.includes("mechas")) parts.push("cabelos coloridos");
      }

      // calor
      if (answers?.calor && answers.calor !== "Nunca") {
        parts.push("protecao termica");
      }

      // fragrância (opcional)
      if (answers?.fragrancia && answers.fragrancia !== "Neutra") {
        parts.push(answers.fragrancia.toLowerCase());
      }

      return parts.join(" ");
    }

    // -------- Scraping do Meu Cabelo Natural --------
    function absoluteUrl(u) {
      if (!u) return "";
      if (/^https?:\/\//i.test(u)) return u;
      if (u.startsWith("/")) return BASE + u;
      return BASE + "/" + u;
    }

    function parseBRL(txt) {
      if (!txt) return 0;
      const t = txt.replace(/\s+/g, " ").trim();
      // aceita "R$ 79,90" ou "R$ 79.90" (casos raros)
      const m = t.match(/R\$\s*([\d.]+,\d{2})/);
      if (m) return Number(m[1].replace(/\./g, "").replace(",", "."));
      const m2 = t.match(/R\$\s*([\d.]+\.\d{2})/);
      if (m2) return Number(m2[1].replace(/\./g, ""));
      return 0;
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
      ];
      const hit = known.find((b) => name.toLowerCase().includes(b.toLowerCase()));
      return hit || "";
    }

    function parseProductsFromHTML(html) {
      const $ = cheerio.load(html);
      const items = [];

      // Magento: cards .product-item / link .product-item-link
      $(".product-item").each((_, el) => {
        const root = $(el);

        const a = root.find("a.product-item-link").first();
        const name = (a.text() || "").trim();
        const href = a.attr("href") || "";

        // imagem
        let img =
          root.find("img.product-image-photo").attr("src") ||
          root.find("img.product-image-photo").attr("data-src") ||
          root.find("img").first().attr("src") ||
          "";

        // preço (pode variar e às vezes vem 0 / só no carrinho)
        const priceText =
          root.find(".price").first().text().trim() ||
          root.find("[data-price-type]").first().text().trim() ||
          "";
        const price = parseBRL(priceText);

        // estoque (muitos sites mostram "Fora de estoque")
        const stockText = root.text().toLowerCase();
        const outOfStock = stockText.includes("fora de estoque");

        if (!name || !href) return;

        items.push({
          nome: name,
          marca: extractBrandFromName(name) || "Meu Cabelo Natural",
          preco: toBRL(price || 0),
          foto: absoluteUrl(img),
          onde_comprar: absoluteUrl(href),
          _out: outOfStock,
        });
      });

      // fallback (se o seletor mudar)
      if (items.length === 0) {
        $("a[href]").each((_, a) => {
          const href = $(a).attr("href") || "";
          const name = ($(a).attr("title") || $(a).text() || "").trim();
          if (!name || name.length < 6) return;
          if (!href.includes(BASE)) return;

          const img = $(a).find("img").attr("src") || $(a).find("img").attr("data-src") || "";
          items.push({
            nome: name,
            marca: extractBrandFromName(name) || "Meu Cabelo Natural",
            preco: 0,
            foto: absoluteUrl(img),
            onde_comprar: absoluteUrl(href),
            _out: false,
          });
        });
      }

      return items;
    }

    async function mcnSearch(query) {
      const url = SEARCH_URL(query);
      const r = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "user-agent": "Mozilla/5.0",
          accept: "text/html,application/xhtml+xml",
        },
      });
      if (!r.ok) return [];
      const html = await r.text();
      return parseProductsFromHTML(html);
    }

    function scoreProduct(p, answers, cat, budgetMin, budgetMax) {
      let s = 0;
      const name = (p.nome || "").toLowerCase();

      if (isForbidden(name)) return -Infinity;
      if (!isHairCategory(name)) s -= 6;

      // penaliza fora de estoque
      if (p._out) s -= 8;

      // categoria
      if (cat) {
        for (const kw of cat.split(/\s+/)) {
          if (kw && name.includes(kw.toLowerCase())) s += 2;
        }
      }

      // tipo
      if (answers?.tipo && name.includes(answers.tipo.toLowerCase())) s += 1.5;

      // incômodos
      for (const inc of answers.inc || []) {
        const k = (inc || "").toLowerCase();
        if (k && name.includes(k)) s += 1.25;
      }

      // orçamento (se preço conhecido)
      if (p.preco > 0) {
        if (inBudget(p.preco, budgetMin, budgetMax)) s += 2.5;
        else s -= 3.5;
      } else {
        // preço desconhecido: pequena penalidade
        s -= 0.75;
      }

      // foto/link
      if (p.foto && isHttps(p.foto)) s += 0.5;
      if (p.onde_comprar && p.onde_comprar.startsWith(BASE + "/")) s += 0.75;

      // marca
      if (p.marca) s += 0.25;

      return s;
    }

    // ===== Busca por até 3 categorias coerentes =====
    const [BUDGET_MIN, BUDGET_MAX] = parseBudgetRange(answers?.orcamento);
    const cats = desiredCategories(answers).slice(0, 3);

    const results = [];
    for (const cat of cats) {
      const q = buildQueryForCategory(cat, answers);
      let lst = await mcnSearch(q);

      lst = lst
        .filter((p) => p && p.nome && p.onde_comprar)
        .filter((p) => !isForbidden(p.nome))
        .filter((p) => isHairCategory(p.nome));

      lst.forEach((p) =>
        results.push({
          ...p,
          _score: scoreProduct(p, answers, cat, BUDGET_MIN, BUDGET_MAX),
        })
      );
    }

    // 1ª passada: só orçamento estrito quando preço conhecido (se preco==0, deixa passar)
    const strict = results.filter((p) => p._score > -Infinity && (p.preco > 0 ? inBudget(p.preco, BUDGET_MIN, BUDGET_MAX) : true));

    // 2ª passada: se <3, amplia faixa em ±20% (quando preço conhecido)
    let pool = strict;
    if (pool.length < 3) {
      const widenMin = Math.max(0, Math.floor(BUDGET_MIN * 0.8));
      const widenMax = Math.ceil(BUDGET_MAX * 1.2);
      pool = results.filter((p) => p._score > -Infinity && (p.preco > 0 ? inBudget(p.preco, widenMin, widenMax) : true));
    }

    // ordenar e deduplicar por URL
    const seen = new Set();
    const ranked = pool
      .sort((a, b) => b._score - a._score)
      .filter((p) => p.onde_comprar && p.onde_comprar.startsWith(BASE + "/"))
      .filter((p) => (seen.has(p.onde_comprar) ? false : (seen.add(p.onde_comprar), true)));

    // preço estimado: mantém dentro do orçamento quando o site não mostra
    function estimatePrice(i) {
      // distribui dentro do orçamento sem estourar
      const min = Math.max(19.9, BUDGET_MIN || 0);
      const max = Math.max(min + 10, BUDGET_MAX || 150);
      const candidates = [
        Math.min(max, Math.max(min, 49.9)),
        Math.min(max, Math.max(min, 69.9)),
        Math.min(max, Math.max(min, 89.9)),
      ];
      return toBRL(candidates[i % candidates.length]);
    }

    const top3 = ranked.slice(0, 3).map((p, i) => {
      const foto = isHttps(p.foto) ? p.foto : HAIR_FALLBACK_IMGS[i % HAIR_FALLBACK_IMGS.length];
      const preco = p.preco && p.preco > 0 ? toBRL(p.preco) : estimatePrice(i);

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

      const motivo = `Alinhado ao seu perfil (${(answers?.tipo || "cabelo").toLowerCase()}), foco em ${(answers?.inc?.[0] || "suas necessidades").toLowerCase()} e orçamento.`;

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

    // completar se ainda tiver < 3
    while (top3.length < 3) {
      top3.push({
        id: "mcn-extra-" + (top3.length + 1),
        nome: "Tratamento Capilar (Meu Cabelo Natural)",
        marca: "Meu Cabelo Natural",
        preco: toBRL(Math.max(BUDGET_MIN, 59.9)),
        foto: HAIR_FALLBACK_IMGS[top3.length % HAIR_FALLBACK_IMGS.length],
        beneficios: ["Cuidado capilar coerente ao seu perfil"],
        motivo: "Completa sua rotina respeitando seu orçamento.",
        onde_comprar: SEARCH_URL("cabelo tratamento"),
      });
    }

    res.json({ products: top3.slice(0, 3) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Falha ao gerar produtos (MCN filtros)" });
  }
});

// ---------------- PIX: criar cobrança (FAKE ou REAL) ----------------
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

    res.json({
      paymentId,
      qr_base64: "data:image/png;base64," + (trx.qr_code_base64 || ""),
      copia_cola: trx.qr_code || "",
      fake: false,
      amount,
      description,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Falha ao criar Pix" });
  }
});

// ---------------- PIX: status ----------------
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

// ---------------- Proxy de imagens ----------------
app.get("/api/img", async (req, res) => {
  try {
    const url = (req.query.u || "").toString();
    if (!/^https?:\/\//i.test(url)) return res.status(400).send("Bad url");
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "" } });
    if (!r.ok) return res.status(502).send("Bad upstream");
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

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API on http://0.0.0.0:${PORT}  |  Fake PIX: ${isFakePix ? "ON" : "OFF"}`);
});
