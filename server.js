// server.js (CommonJS) — Produção: OPAQUE (Face) + PIX (FAKE opcional) + Proxy Imagens + Leads (Google Sheets)
// vFinal: SEMPRE 5 produtos + orçamento com fallback para faixas ACIMA + evita indisponíveis + link afiliado Rakuten em todos os links

require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

// Mercado Pago v2
const mercadopago = require("mercadopago");
const { MercadoPagoConfig, Payment } = mercadopago;

// OpenAI (mantido por compatibilidade — NÃO é obrigatório aqui)
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

// ===================== Afiliado Rakuten (Opaque) =====================
const AFFILIATE_UTM =
  "utm_source=rakuten&utm_medium=afiliados&utm_term=4587713&ranMID=47714&ranEAID=OyPY4YHfHl4&ranSiteID=OyPY4YHfHl4-5t9np1DoTPuG6fO28twrDA";

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

function withAffiliate(url) {
  try {
    if (!url) return "";
    const u = new URL(url);
    // mantém o que já tem e adiciona/garante os params
    const params = new URLSearchParams(u.search);
    const extra = new URLSearchParams(AFFILIATE_UTM);
    for (const [k, v] of extra.entries()) {
      if (!params.has(k)) params.set(k, v);
    }
    u.search = params.toString();
    return u.toString();
  } catch {
    return url; // se falhar, retorna original
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

// ===================== Geração: Busca na OPAQUE (Tratamento/Face) =====================
app.post("/api/generate-products", async (req, res) => {
  try {
    const { answers } = req.body || {};
    if (!answers) return res.status(400).json({ error: "answers ausente" });

    const BASE = "https://www.opaque.com.br";

    // VTEX search API
    const SEARCH_API = (q, from = 0, to = 49) =>
      `${BASE}/api/catalog_system/pub/products/search/?ft=${encodeURIComponent(q)}&O=OrderByBestDiscountDESC&_from=${from}&_to=${to}`;

    // Fallbacks (face skincare)
    const FACE_FALLBACK_IMGS = [
      "https://images.pexels.com/photos/3762879/pexels-photo-3762879.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/6621374/pexels-photo-6621374.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/6621467/pexels-photo-6621467.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/6621452/pexels-photo-6621452.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/6621341/pexels-photo-6621341.jpeg?auto=compress&cs=tinysrgb&w=800",
    ];

    const FORBIDDEN_TERMS = [
      "infantil","infantis","baby","bebê","bebe","crianca","criança","kids","menino","menina","pediátric","pediatric","júnior","junior"
    ];

    // Keywords focadas em FACE / skincare
    const FACE_KEYWORDS = [
      "facial","rosto","face","limpeza","limpador","gel de limpeza","sabonete","cleansing","cleanser",
      "hidratante","moisturizer","creme","gel creme","ácido","acido","niacinamida","vitamina c","retinol","hialur",
      "protetor","fps","solar","sunscreen","serum","sérum","tônico","tonico","esfol","peeling","máscara","mascara",
      "água micelar","agua micelar","micelar","demaquil","removedor","oil cleanser"
    ];

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
      if (has(["gel de limpeza","limpeza","limpador","sabonete","cleanser","cleansing","micelar","demaquil","removedor"])) return "cleanser";
      if (has(["esfol","peeling"])) return "exfoliant";
      if (has(["hidrat","moistur","creme","gel creme"])) return "moisturizer";
      if (has(["protet","fps","solar","sunscreen"])) return "sunscreen";
      if (has(["serum","sérum","vitamina c","niacin","retinol","hialur","ácido","acido"])) return "serum";
      if (has(["tônico","tonico"])) return "toner";
      if (has(["máscara","mascara"])) return "mask";
      return "other";
    }

    function normalizeOpaqueProduct(p) {
      const name = p?.productName || "";
      const brand = p?.brand || "Opaque";
      const linkText = p?.linkText || "";

      // VTEX costuma entregar um "link" absoluto; se não vier, monta
      let url = p?.link || (linkText ? `${BASE}/${linkText}/p` : "");
      url = withAffiliate(url);

      const item = Array.isArray(p?.items) ? p.items[0] : null;
      const img = item?.images?.[0]?.imageUrl || "";

      const seller = Array.isArray(item?.sellers) ? item.sellers[0] : null;
      const offer = seller?.commertialOffer || {};

      const price = Number(offer?.Price || offer?.spotPrice || 0);
      const availableQty = Number(offer?.AvailableQuantity || 0);
      const isAvailable = offer?.IsAvailable;
      const out = (isAvailable === false) || (availableQty === 0);

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

      return data
        .map(normalizeOpaqueProduct)
        .filter((x) => x && x.nome && x.onde_comprar && x.onde_comprar.startsWith(BASE + "/"));
    }

    // ========= ORÇAMENTO (faixas) =========
    // Deve casar com as opções do seu index.html
    const RANGES = [
      { label: "Até R$ 60", min: 0, max: 60 },
      { label: "R$ 61 - R$ 120", min: 61, max: 120 },
      { label: "R$ 121 - R$ 200", min: 121, max: 200 },
      { label: "R$ 201 - R$ 350", min: 201, max: 350 },
      { label: "R$ 351 - R$ 600", min: 351, max: 600 },
      { label: "R$ 601+", min: 601, max: 999999 },
    ];

    function detectRangeIndex(txt) {
      const t = (txt || "").toLowerCase();
      const idx = RANGES.findIndex(r => t.includes(r.label.toLowerCase().replace(/\s+/g," ")));
      if (idx >= 0) return idx;

      // fallback heurístico
      if (t.includes("até") || t.includes("ate")) return 0;
      if (t.includes("61") || t.includes("120")) return 1;
      if (t.includes("121") || t.includes("200")) return 2;
      if (t.includes("201") || t.includes("350")) return 3;
      if (t.includes("351") || t.includes("600")) return 4;
      if (t.includes("601")) return 5;
      return 0;
    }

    function inBudget(price, min, max) {
      return Number.isFinite(price) && price >= min && price <= max;
    }

    // ========= QUERIES (para garantir volume) =========
    // Monta consultas “slot-based” e também “fallback queries”
    const pele = (answers?.pele || "").toLowerCase();
    const sensibilidade = (answers?.sensibilidade || "").toLowerCase();
    const protetor = (answers?.protetor || "").toLowerCase();
    const rotina = (answers?.rotina || "").toLowerCase();
    const textura = (answers?.textura || "").toLowerCase();
    const inc = Array.isArray(answers?.inc) ? answers.inc : [];
    const incTxt = inc.join(" ").toLowerCase();

    function baseHints() {
      const parts = [];
      if (pele.includes("oleos")) parts.push("pele oleosa");
      if (pele.includes("seca")) parts.push("pele seca");
      if (pele.includes("mista")) parts.push("pele mista");
      if (pele.includes("sens")) parts.push("pele sensível");
      if (sensibilidade.includes("alta")) parts.push("sensível");
      if (textura.includes("gel")) parts.push("gel");
      if (textura.includes("crem")) parts.push("creme");
      if (incTxt.includes("acne") || incTxt.includes("cravos")) parts.push("acne");
      if (incTxt.includes("oleos")) parts.push("controle de oleosidade");
      if (incTxt.includes("manchas")) parts.push("manchas");
      if (incTxt.includes("linhas") || incTxt.includes("idade")) parts.push("anti-idade");
      if (incTxt.includes("ressec")) parts.push("hidratação");
      if (incTxt.includes("sensibilidade") || incTxt.includes("vermel")) parts.push("calmante");
      if (incTxt.includes("olheiras")) parts.push("olheiras");
      return parts;
    }

    // Slots para rotina facial (5 itens)
    const slotCats = [
      "gel de limpeza facial",
      "hidratante facial",
      "protetor solar facial",
      "sérum facial",
      "esfoliante facial",
    ];

    function buildQuery(cat) {
      const parts = [cat, ...baseHints()];
      // se não usa protetor, tenta puxar protetor mais ainda (no slot específico já vai)
      if (cat.includes("protetor") && (protetor.includes("não") || protetor.includes("nao"))) {
        parts.push("fps");
      }
      // rotina muito simples: reforça produtos básicos
      if (rotina.includes("quase") || rotina.includes("simples")) {
        if (cat.includes("sérum") || cat.includes("esfol")) parts.push("leve");
      }
      return parts.join(" ").trim();
    }

    // Fallback queries (bem amplas) para completar volume
    const fallbackQueries = [
      "limpador facial",
      "sabonete facial",
      "hidratante facial",
      "protetor solar facial fps",
      "serum facial vitamina c",
      "niacinamida facial",
      "acido hialuronico facial",
      "esfoliante facial",
      "tônico facial",
      "agua micelar",
      "máscara facial",
      "tratamento facial",
    ].map(q => q + " " + baseHints().join(" "));

    // ========= Score / seleção =========
    function scoreProduct(p, slotText) {
      let s = 0;
      const name = (p.nome || "").toLowerCase();

      if (!p.nome || !p.onde_comprar) return -Infinity;
      if (isForbidden(name)) return -Infinity;
      if (p._out) return -Infinity;

      // precisa ser “face/skincare” (não elimina 100%, mas penaliza MUITO)
      if (!isFaceCategory(name)) s -= 6;
      else s += 2;

      // encaixe com slot
      if (slotText) {
        const key = slotText.toLowerCase();
        const firstWord = key.split(" ")[0];
        if (firstWord && name.includes(firstWord)) s += 2.2;
        // reforça palavras do slot
        for (const w of key.split(/\s+/)) {
          if (w.length >= 4 && name.includes(w)) s += 0.5;
        }
      }

      // sinais de adequação por perfil
      if (pele.includes("oleos") && (name.includes("oil") || name.includes("oleos") || name.includes("matte"))) s += 0.6;
      if (pele.includes("seca") && (name.includes("hydr") || name.includes("hidrat") || name.includes("creme"))) s += 0.6;
      if (pele.includes("sens") && (name.includes("sens") || name.includes("calm") || name.includes("suave"))) s += 0.6;

      // imagem/link
      if (p.foto && isHttps(p.foto)) s += 0.6;
      if (p.onde_comprar && p.onde_comprar.includes("/p")) s += 0.8; // preferir páginas de produto

      // preço
      if (p.preco > 0) s += 0.3;

      return s;
    }

    function makeBenefits(p) {
      const n = (p.nome || "").toLowerCase();
      const b = [];
      if (n.includes("fps") || n.includes("solar") || n.includes("protet")) b.push("Proteção diária para a pele");
      if (n.includes("hidrat") || n.includes("hialur") || n.includes("moistur")) b.push("Hidratação e conforto");
      if (n.includes("vitamina c") || n.includes("vit c")) b.push("Ajuda no viço e uniformização");
      if (n.includes("niacin")) b.push("Ajuda no controle de oleosidade e poros");
      if (n.includes("retinol")) b.push("Apoio anti-idade (uso noturno)");
      if (n.includes("esfol") || n.includes("peeling")) b.push("Renovação suave da pele");
      if (b.length === 0) b.push("Combina com seu perfil e rotina facial");
      return b.slice(0, 4);
    }

    // ========= 1) Busca ampla + 2) Filtra por faixa =========
    const slotQueries = slotCats.map(c => buildQuery(c));
    const allQueries = [...slotQueries, ...fallbackQueries];

    const rawResults = [];
    for (let i = 0; i < allQueries.length; i++) {
      const q = allQueries[i];
      const lst = await opaqueSearch(q);

      // filtra duplicatas cedo
      for (const p of lst) {
        if (!p || !p.onde_comprar) continue;
        rawResults.push(p);
      }
    }

    // normaliza/filtra base (sem indisponível, sem proibido, com link produto preferível)
    const basePool = rawResults
      .filter(p => p && p.nome && p.onde_comprar)
      .filter(p => !isForbidden(p.nome))
      .filter(p => !p._out)
      .filter(p => p.onde_comprar.startsWith(BASE + "/"));

    // remove duplicatas por URL
    const uniq = [];
    const seenUrl = new Set();
    for (const p of basePool) {
      const u = p.onde_comprar;
      if (seenUrl.has(u)) continue;
      seenUrl.add(u);
      uniq.push(p);
    }

    // ========= orçamento: começa na faixa escolhida; se não tiver 5, sobe faixas =========
    const chosenIdx = detectRangeIndex(answers?.orcamento);
    const rangesToTry = [];
    for (let i = chosenIdx; i < RANGES.length; i++) rangesToTry.push(RANGES[i]);

    // monta lista de candidatos por faixa
    let budgetNotice = "";
    let finalPool = [];
    let usedRange = rangesToTry[0];

    for (let i = 0; i < rangesToTry.length; i++) {
      const r = rangesToTry[i];
      const filtered = uniq.filter(p => p.preco > 0 ? inBudget(p.preco, r.min, r.max) : true);

      if (filtered.length >= 5) {
        finalPool = filtered;
        usedRange = r;
        if (i > 0) {
          budgetNotice =
            `Não encontramos 5 produtos na faixa escolhida (${RANGES[chosenIdx].label}). ` +
            `Mostrando produtos na próxima faixa (${r.label}).`;
        }
        break;
      }
    }

    // se nenhuma faixa tem 5, usa o máximo possível e completa com os melhores (mesmo fora de orçamento)
    if (finalPool.length < 5) {
      // pega o melhor "até o máximo" da faixa escolhida primeiro
      const baseRange = RANGES[chosenIdx] || RANGES[0];
      const upToMax = uniq.filter(p => p.preco > 0 ? p.preco <= baseRange.max : true);
      finalPool = upToMax.length ? upToMax : uniq;

      if (finalPool.length < 5) {
        // última tentativa: remove regra de faceKeywords (ainda sem indisponível) e aceita tudo do uniq mesmo
        finalPool = uniq;
      }

      if (finalPool.length < 5) {
        budgetNotice =
          `Encontramos poucos itens disponíveis agora. Mesmo assim, vamos te mostrar as melhores opções que encontramos no momento.`;
      } else {
        budgetNotice =
          `Não encontramos 5 produtos na faixa escolhida (${baseRange.label}). ` +
          `Mostrando opções disponíveis acima/fora da faixa para você não ficar sem recomendações.`;
      }
    }

    // ========= Rank com score + diversidade por tipo =========
    // calcula score para cada slot e usa um mix preferido (5 slots)
    const preferredTypesBySlot = [
      new Set(["cleanser"]),
      new Set(["moisturizer"]),
      new Set(["sunscreen"]),
      new Set(["serum","toner"]),
      new Set(["exfoliant","mask","other"]),
    ];

    const scored = finalPool.map(p => {
      // score "geral" considerando vários slots (puxa para o topo)
      let best = -Infinity;
      for (const sq of slotCats) {
        best = Math.max(best, scoreProduct(p, sq));
      }
      return { ...p, _score: best };
    })
    .filter(p => p._score > -Infinity)
    .sort((a,b) => b._score - a._score);

    function pickForSlot(list, slotIdx, chosenUrls) {
      const preferred = preferredTypesBySlot[slotIdx];
      const candidates = list.filter(p => !chosenUrls.has(p.onde_comprar));
      const preferredOnes = candidates.filter(p => preferred.has(p._type));
      const best = (preferredOnes.length ? preferredOnes : candidates).sort((a,b) => b._score - a._score)[0];
      return best || null;
    }

    const chosenUrls2 = new Set();
    const chosen = [];

    for (let slot = 0; slot < 5; slot++) {
      const p = pickForSlot(scored, slot, chosenUrls2);
      if (!p) break;
      chosen.push(p);
      chosenUrls2.add(p.onde_comprar);
    }

    // completa se faltar
    let k = 0;
    while (chosen.length < 5 && k < scored.length) {
      const p = scored[k++];
      if (!p) break;
      if (chosenUrls2.has(p.onde_comprar)) continue;
      chosen.push(p);
      chosenUrls2.add(p.onde_comprar);
    }

    // se ainda faltar, cria itens apontando para outlet (último fallback — evita "face" categoria)
    while (chosen.length < 5) {
      chosen.push({
        nome: "Ver mais ofertas no Outlet Opaque",
        marca: "Opaque",
        foto: FACE_FALLBACK_IMGS[chosen.length % FACE_FALLBACK_IMGS.length],
        preco: toBRL(Math.max(49.9, (RANGES[chosenIdx]?.min || 0))),
        onde_comprar: withAffiliate(`${BASE}/outlet?O=OrderByBestDiscountDESC`),
        _type: "other",
        _score: 0,
      });
    }

    // ========= Monta resposta final =========
    const top5 = chosen.slice(0, 5).map((p, i) => {
      const foto = isHttps(p.foto) ? p.foto : FACE_FALLBACK_IMGS[i % FACE_FALLBACK_IMGS.length];
      const preco = p.preco && p.preco > 0 ? toBRL(p.preco) : toBRL(Math.max(49.9, (RANGES[chosenIdx]?.min || 0)));

      // garante afiliado no link
      const buy = withAffiliate(p.onde_comprar);

      return {
        id: ("opaque-" + Buffer.from(buy).toString("base64")).replace(/=+$/, ""),
        nome: p.nome,
        marca: p.marca || "Opaque",
        preco,
        foto,
        beneficios: makeBenefits(p),
        motivo: "Selecionado para montar uma rotina facial prática (limpeza, hidratação, proteção e tratamento), respeitando seu perfil.",
        onde_comprar: buy,
      };
    });

    return res.json({
      products: top5,
      budget_notice: budgetNotice || "",
      used_budget: usedRange?.label || (RANGES[chosenIdx]?.label || ""),
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
