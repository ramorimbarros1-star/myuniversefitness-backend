// server.js (CommonJS) — v2: IA + PIX (FAKE_PIX opcional) + Proxy de Imagens
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

// CORS: libera qualquer porta localhost/127.0.0.1 (dev)
const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, cb) {
    // permite curl/postman/servidor (sem origin)
    if (!origin) return cb(null, true);

    if (allowedOrigins.includes(origin)) return cb(null, true);

    return cb(new Error("Not allowed by CORS: " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
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

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Health
app.get("/api/health", (req, res) => res.json({ ok: true, fakePix: isFakePix }));

function realToNumber(v) { return Math.round(Number(v) * 100) / 100; }

// Regras: sempre buscar no domínio belezanaweb.com.br e retornar 3 produtos reais com imagem e link do site.
// ---------------- Geração por BUSCA na Beleza na Web (com filtros rígidos) ----------------
app.post("/api/generate-products", async (req, res) => {
  try {
    const { answers } = req.body || {};
    if (!answers) return res.status(400).json({ error: "answers ausente" });

    // ===== Helpers / Config =====
    const BASE = "https://www.belezanaweb.com.br";
    const SEARCH_URL = (q) => `${BASE}/busca?q=${encodeURIComponent(q)}`;

    // FALLBACKS 100% capilares (inclui ilustrações/flat/cartoon de frascos, cabelo etc.)
   const HAIR_FALLBACK_IMGS = [
  // Mulher escovando o cabelo
  "https://images.pexels.com/photos/3992872/pexels-photo-3992872.jpeg?auto=compress&cs=tinysrgb&w=800",

  // Cabeleireiro lavando o cabelo de cliente
  "https://images.pexels.com/photos/3993449/pexels-photo-3993449.jpeg?auto=compress&cs=tinysrgb&w=800",

  // Mulher sorrindo enquanto seca os cabelos
  "https://images.pexels.com/photos/8534274/pexels-photo-8534274.jpeg?auto=compress&cs=tinysrgb&w=800",

  // Aplicando tratamento capilar em salão
  "https://images.pexels.com/photos/3992871/pexels-photo-3992871.jpeg?auto=compress&cs=tinysrgb&w=800",

  // Pessoa cuidando dos cabelos em casa (passando a mão, rotina de haircare)
  "https://images.pexels.com/photos/3993446/pexels-photo-3993446.jpeg?auto=compress&cs=tinysrgb&w=800"
];

    const FORBIDDEN_TERMS = [
      "infantil","infantis","baby","bebê","crianca","criança","kids","menino","menina","pediátric","júnior","junior"
    ];

    const HAIR_KEYWORDS = [
      "shampoo","condicionador","máscara","mascara","leave-in","leave in","tônico","tonico","óleo","oleo",
      "ampola","protetor térmico","protetor termico","finalizador","sérum","serum","tônico capilar","loção capilar",
      "spray capilar","esfoliante capilar","tônico anticaspa","antioleosidade","antifrizz","reparador de pontas"
    ];

    const toBRL = (v) => Math.round(Number(v) * 100) / 100;
    const isHttps = (u) => { try { const x = new URL(u); return x.protocol === "https:"; } catch { return false; } };

    function parseBudgetRange(txt) {
      const t = (txt || "").toLowerCase();
      if (t.includes("até r$ 80") || t.includes("ate r$ 80") || t.includes("até 80")) return [0, 80];
      if (t.includes("81") || t.includes("r$ 81") || t.includes("81 - 150")) return [81, 150];
      if (t.includes("151") || t.includes("r$ 151") || t.includes("151 - 250")) return [151, 250];
      if (t.includes("251") || t.includes("r$ 251")) return [251, 9999];
      return [0, 9999];
    }

    function desiredCategories(answers) {
      const inc = (answers.inc || []);
      const cats = [];
      if (inc.includes("Oleosidade")) cats.push("shampoo antioleosidade");
      if (inc.includes("Caspa"))       cats.push("shampoo anticaspa");
      if (inc.includes("Queda"))       cats.push("tônico antiqueda");
      if (inc.includes("Ressecamento"))cats.push("máscara hidratante");
      if (inc.includes("Frizz"))       cats.push("leave-in antifrizz");
      if (inc.includes("Pontas duplas")) cats.push("óleo reparador");
      if (inc.includes("Falta de brilho")) cats.push("sérum brilho");
      if (cats.length === 0) cats.push("shampoo","máscara hidratante","leave-in");
      return [...new Set(cats)].slice(0, 4);
    }

    function buildQueryForCategory(cat, answers) {
      const parts = [cat];
      if (answers?.tipo) parts.push(`cabelo ${answers.tipo.toLowerCase()}`);
      if (answers?.fragrancia && answers.fragrancia !== "Neutra") {
        parts.push(answers.fragrancia.toLowerCase());
      }
      return parts.join(" ");
    }

    // === scraping (cheerio deve estar instalado e require('cheerio') no topo do arquivo)
    function parseProductsFromHTML(html) {
      const $ = cheerio.load(html);
      const items = [];

      // 1) JSON-LD Product
      $('script[type="application/ld+json"]').each((_, el) => {
        let txt = $(el).contents().text();
        if (!txt) return;
        try {
          const data = JSON.parse(txt);
          const bucket = [];
          if (Array.isArray(data)) bucket.push(...data);
          else if (data["@graph"]) bucket.push(...data["@graph"]);
          else bucket.push(data);

          bucket.forEach((node) => {
            try {
              if (!node) return;
              const types = []
                .concat(node["@type"] || [])
                .map((t) => (typeof t === "string" ? t.toLowerCase() : ""));
              if (!types.includes("product")) return;

              const name = node.name || node.productName || "";
              const brand = (typeof node.brand === "string")
                ? node.brand
                : (node.brand && node.brand.name) || "";
              const url = node.url || "";
              let image = "";
              if (typeof node.image === "string") image = node.image;
              else if (Array.isArray(node.image)) image = node.image[0] || "";

              // preço
              let price = 0;
              if (node.offers) {
                if (Array.isArray(node.offers)) {
                  for (const o of node.offers) {
                    const p = Number((o && (o.price || o.lowPrice || o.highPrice)) || 0);
                    if (p > 0) { price = p; break; }
                  }
                } else {
                  price = Number(node.offers.price || node.offers.lowPrice || node.offers.highPrice || 0);
                }
              }

              if (name && url && url.startsWith(`${BASE}/`)) {
                items.push({
                  nome: name.trim(),
                  marca: (brand || "").toString().trim(),
                  preco: toBRL(price || 0),
                  foto: image || "",
                  onde_comprar: url
                });
              }
            } catch {}
          });
        } catch {}
      });

      // 2) fallback raso (a + img)
      if (items.length === 0) {
        $('a[href^="https://www.belezanaweb.com.br/"]').each((_, a) => {
          const href = $(a).attr("href") || "";
          const img = $(a).find("img").attr("src") || $(a).find("img").attr("data-src") || "";
          const name = ($(a).attr("title") || $(a).text() || "").trim();
          if (href.includes("/") && name.length > 5) {
            items.push({
              nome: name,
              marca: "",
              preco: 0,
              foto: img || "",
              onde_comprar: href
            });
          }
        });
      }

      return items;
    }

    async function bnwSearch(query) {
      const url = SEARCH_URL(query);
      const r = await fetch(url, { method: "GET", redirect: "follow" });
      if (!r.ok) return [];
      const html = await r.text();
      return parseProductsFromHTML(html);
    }

    // ==== FILTROS RÍGIDOS ====
    const [BUDGET_MIN, BUDGET_MAX] = parseBudgetRange(answers?.orcamento);

    function isForbidden(name) {
      const n = (name || "").toLowerCase();
      return FORBIDDEN_TERMS.some(t => n.includes(t));
    }
    function isHairCategory(name) {
      const n = (name || "").toLowerCase();
      return HAIR_KEYWORDS.some(k => n.includes(k));
    }
    function inBudget(price, min, max) {
      return Number.isFinite(price) && price >= min && price <= max;
    }

    function enrichBrandWhenMissing(p) {
      if (!p.marca) {
        const m = (p.nome || "").match(/\b(Natura|L(?:'|´)?Or(?:é|e)al|Salon Line|Wella|Lola|Truss|Eudora|Dove|Pantene|TRESemmé|Siàge|Acquaflora|Inoar|Amend|Elseve|Skala|Haskell|Forever Liss|Eico|Kérastase|Kerastase|Keune|Redken|Bio Extratus|Granado|Niely|Alta Moda|Senscience|Joico)\b/i);
        if (m) p.marca = m[0];
      }
      return p;
    }

    function scoreProduct(p, answers, cat) {
      let s = 0;
      const name = (p.nome || "").toLowerCase();

      // filtros duros (se falhar aqui, nem deveria ser avaliado)
      if (isForbidden(name)) return -Infinity;
      if (!isHairCategory(name)) s -= 5; // não elimina, mas penaliza muito

      // categoria
      if (cat) {
        for (const kw of cat.split(/\s+/)) {
          if (kw && name.includes(kw.toLowerCase())) s += 2;
        }
      }

      // tipo de cabelo
      if (answers?.tipo && name.includes(answers.tipo.toLowerCase())) s += 1.5;

      // incômodos
      for (const inc of (answers.inc || [])) {
        const k = inc.toLowerCase();
        if (name.includes(k)) s += 1.25;
      }

      // orçamento
      if (p.preco > 0) {
        if (inBudget(p.preco, BUDGET_MIN, BUDGET_MAX)) s += 2.5;
        else s -= 2.5;
      }

      // marca/preço/foto
      if (p.marca) s += 0.5;
      if (p.foto && isHttps(p.foto)) s += 0.5;
      if (p.preco > 0) s += 0.5;

      return s;
    }

    // ===== Busca por até 3 categorias coerentes =====
    const cats = desiredCategories(answers).slice(0, 3);
    const results = [];
    for (const cat of cats) {
      const q = buildQueryForCategory(cat, answers);
      let lst = await bnwSearch(q);

      // enriquecer marca quando ausente e filtrar infantil + capilar
      lst = lst.map(enrichBrandWhenMissing)
               .filter(p => !isForbidden(p.nome))
               .filter(p => isHairCategory(p.nome));

      // push com score
      lst.forEach((p) => results.push({ ...p, _score: scoreProduct(p, answers, cat) }));
    }

    // 1ª passada: só orçamento estrito
    const strict = results.filter(p => p._score > -Infinity && (p.preco > 0 ? inBudget(p.preco, BUDGET_MIN, BUDGET_MAX) : true));

    // 2ª passada (fallback): se não alcançou 3, amplia faixa em ±20%
    let pool = strict;
    if (pool.length < 3) {
      const widenMin = Math.max(0, Math.floor(BUDGET_MIN * 0.8));
      const widenMax = Math.ceil(BUDGET_MAX * 1.2);
      pool = results.filter(p => p._score > -Infinity && (p.preco > 0 ? inBudget(p.preco, widenMin, widenMax) : true));
    }

    // ordenar por score e tirar duplicatas por URL
    const seen = new Set();
    const ranked = pool
      .sort((a,b) => b._score - a._score)
      .filter(p => p.onde_comprar && p.onde_comprar.startsWith(BASE + "/"))
      .filter(p => (seen.has(p.onde_comprar) ? false : (seen.add(p.onde_comprar), true)));

    // monta top3 com normalização final (imagem capilar sempre que necessário)
    const top3 = ranked.slice(0, 3).map((p, i) => {
      let foto = isHttps(p.foto) ? p.foto : HAIR_FALLBACK_IMGS[i % HAIR_FALLBACK_IMGS.length];
      let preco = p.preco && p.preco > 0 ? toBRL(p.preco) : toBRL(Math.max(BUDGET_MIN, 59.9));

      const beneficios = [];
      const nameLc = (p.nome || "").toLowerCase();
      if (nameLc.includes("oleos")) beneficios.push("Ajuda a controlar oleosidade");
      if (nameLc.includes("hidr") || nameLc.includes("nutri")) beneficios.push("Hidratação / nutrição");
      if (nameLc.includes("frizz")) beneficios.push("Redução de frizz");
      if (nameLc.includes("brilho")) beneficios.push("Mais brilho");
      if (nameLc.includes("anticaspa")) beneficios.push("Ação anticaspa");
      if (nameLc.includes("repar") || nameLc.includes("pontas")) beneficios.push("Reparação de pontas");
      if (beneficios.length === 0) beneficios.push("Cuidado capilar coerente ao seu perfil");

      const motivo = `Alinhado ao seu perfil (${(answers?.tipo || 'cabelo').toLowerCase()}), foco em ${(answers?.inc?.[0] || 'suas necessidades').toLowerCase()} e orçamento.`;

      return {
        id: ("bnw-" + Buffer.from(p.onde_comprar).toString("base64")).replace(/=+$/,""),
        nome: p.nome,
        marca: p.marca || "Marca",
        preco,
        foto,
        beneficios: beneficios.slice(0,4),
        motivo,
        onde_comprar: p.onde_comprar
      };
    });

    // completar se ainda tiver < 3
    while (top3.length < 3) {
      top3.push({
        id: "bnw-extra-" + (top3.length + 1),
        nome: "Tratamento Capilar Beleza na Web",
        marca: "Marca",
        preco: toBRL(Math.max(BUDGET_MIN, 59.9)),
        foto: HAIR_FALLBACK_IMGS[top3.length % HAIR_FALLBACK_IMGS.length],
        beneficios: ["Cuidado capilar coerente ao seu perfil"],
        motivo: "Completa sua rotina respeitando seu orçamento.",
        onde_comprar: SEARCH_URL("tratamento capilar")
      });
    }

    res.json({ products: top3.slice(0,3) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Falha ao gerar produtos (BNW filtros)" });
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
        description
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
          first_name: (nome || "Cliente").toString().split(" ")[0]
        }
      }
    });

    const trx = (payment?.point_of_interaction?.transaction_data) || {};
    const paymentId = payment?.id;

    res.json({
      paymentId,
      qr_base64: "data:image/png;base64," + (trx.qr_code_base64 || ""),
      copia_cola: trx.qr_code || "",
      fake: false,
      amount,
      description
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
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "" } });
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
