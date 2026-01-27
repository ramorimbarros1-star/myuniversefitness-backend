// server.js (CommonJS) — Produção: OPAQUE (Face) + PIX (FAKE opcional) + Proxy Imagens + Leads (Google Sheets)
// FIX: SEMPRE retorna 5 produtos; se não houver na faixa escolhida, sobe para a próxima faixa e retorna "message".
// FIX: NUNCA retorna link de categoria dentro de products (somente links /p de produto).
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

// Mercado Pago v2
const mercadopago = require("mercadopago");
const { MercadoPagoConfig, Payment } = mercadopago;

// OpenAI (mantido por compatibilidade — não é obrigatório)
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

// OpenAI (não usado obrigatoriamente)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Google Sheets webhook
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || "";

// ===================== Afiliado Rakuten (OPAQUE) =====================
const AFFILIATE_PARAMS =
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

// ===================== Geração: OPAQUE (Face/Skincare) =====================
app.post("/api/generate-products", async (req, res) => {
  try {
    const { answers } = req.body || {};
    if (!answers) return res.status(400).json({ error: "answers ausente" });

    const BASE = "https://www.opaque.com.br";

    // ✅ VTEX search API
    const SEARCH_API = (q) =>
      `${BASE}/api/catalog_system/pub/products/search/?ft=${encodeURIComponent(
        q
      )}&O=OrderByBestDiscountDESC&_from=0&_to=49`;

    // Fallbacks de imagem (face/skincare)
    const FACE_FALLBACK_IMGS = [
      "https://images.pexels.com/photos/3762879/pexels-photo-3762879.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/3997989/pexels-photo-3997989.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/3738348/pexels-photo-3738348.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/6621153/pexels-photo-6621153.jpeg?auto=compress&cs=tinysrgb&w=800",
      "https://images.pexels.com/photos/7755460/pexels-photo-7755460.jpeg?auto=compress&cs=tinysrgb&w=800",
    ];

    const FORBIDDEN_TERMS = [
      "infantil","infantis","baby","bebê","bebe","crianca","criança","kids","menino","menina","pediátric","pediatric","júnior","junior"
    ];

    // Keywords de Face/Skincare (para evitar maquiagem/perfume)
    const FACE_KEYWORDS = [
      "facial","rosto","face",
      "limp","clean","gel de limpeza","sabonete","cleansing","micelar","água micelar","agua micelar",
      "tônico","tonico","serum","sérum","essência","essencia","ampola",
      "hidrat","moist","creme facial","gel hidratante",
      "protetor","solar","fps","spf",
      "esfol","peeling","mascara facial","máscara facial",
      "vitamina c","niacinamida","ácido","acido","hialur","retinol","antioxid",
      "olhos","eye","olheiras"
    ];

    function isForbidden(name) {
      const n = (name || "").toLowerCase();
      return FORBIDDEN_TERMS.some((t) => n.includes(t));
    }

    function isFaceProduct(name) {
      const n = (name || "").toLowerCase();
      return FACE_KEYWORDS.some((k) => n.includes(k));
    }

    function inBudget(price, min, max) {
      return Number.isFinite(price) && price >= min && price <= max;
    }

    // Orçamento do seu frontend
    function parseBudgetRange(txt) {
      const t = (txt || "").toLowerCase();
      if (t.includes("até r$ 60") || t.includes("ate r$ 60") || t.includes("até 60") || t.includes("ate 60")) return [0, 60];
      if (t.includes("61") || t.includes("r$ 61") || t.includes("61 - 120")) return [61, 120];
      if (t.includes("121") || t.includes("r$ 121") || t.includes("121 - 200")) return [121, 200];
      if (t.includes("201") || t.includes("r$ 201") || t.includes("201 - 350")) return [201, 350];
      if (t.includes("351") || t.includes("r$ 351") || t.includes("351 - 600")) return [351, 600];
      if (t.includes("601")) return [601, 999999];
      return [0, 999999];
    }

    function budgetLadderFromSelection(selectionText) {
      const ranges = [
        { label: "Até R$ 60", min: 0, max: 60 },
        { label: "R$ 61 - R$ 120", min: 61, max: 120 },
        { label: "R$ 121 - R$ 200", min: 121, max: 200 },
        { label: "R$ 201 - R$ 350", min: 201, max: 350 },
        { label: "R$ 351 - R$ 600", min: 351, max: 600 },
        { label: "R$ 601+", min: 601, max: 999999 },
      ];

      const [selMin, selMax] = parseBudgetRange(selectionText);
      let startIdx = ranges.findIndex(r => r.min === selMin && r.max === selMax);
      if (startIdx < 0) startIdx = 0;

      return ranges.slice(startIdx); // sobe faixa se precisar
    }

    function addAffiliate(url) {
      try {
        const u = new URL(url);
        // mantém parâmetros do produto, adiciona afiliado
        const extra = new URLSearchParams(AFFILIATE_PARAMS);
        extra.forEach((v, k) => {
          if (!u.searchParams.has(k)) u.searchParams.set(k, v);
        });
        return u.toString();
      } catch {
        return url;
      }
    }

    function makeAbsoluteUrl(maybeUrl) {
      if (!maybeUrl) return "";
      if (/^https?:\/\//i.test(maybeUrl)) return maybeUrl;
      if (maybeUrl.startsWith("/")) return BASE + maybeUrl;
      return BASE + "/" + maybeUrl;
    }

    function isValidProductUrl(url) {
      // ✅ garante que é página de produto VTEX (/p)
      return typeof url === "string" && url.startsWith(BASE + "/") && /\/p(\?|$)/.test(url);
    }

    function normalizeOpaqueProduct(p) {
      // Estrutura VTEX:
      // productName, brand, linkText, link, items[0].images[0].imageUrl, sellers[0].commertialOffer.Price/AvailableQuantity
      const name = (p?.productName || "").toString().trim();
      const brand = (p?.brand || "Opaque").toString().trim();
      const linkText = (p?.linkText || "").toString().trim();
      const link = (p?.link || "").toString().trim();

      // URL: tenta p.link; se vier relativo, absolutiza; se não tiver /p, monta por linkText
      let url = makeAbsoluteUrl(link);
      if (!/\/p(\?|$)/.test(url) && linkText) {
        url = `${BASE}/${linkText}/p`;
      }

      const item = Array.isArray(p?.items) ? p.items[0] : null;
      const img = (item?.images?.[0]?.imageUrl || "").toString().trim();

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
        .filter(x => x && x.nome && x.onde_comprar);
    }

    // ===================== Monta queries (Face) a partir das respostas =====================
    const pele = (answers?.pele || "").toLowerCase();
    const sens = (answers?.sensibilidade || "").toLowerCase();
    const protetor = (answers?.protetor || "").toLowerCase();
    const rotina = (answers?.rotina || "").toLowerCase();
    const textura = (answers?.textura || "").toLowerCase();
    const inc = Array.isArray(answers?.inc) ? answers.inc : [];

    function buildQuery(baseTerm) {
      const parts = [baseTerm, "facial"];

      if (pele.includes("oleos")) parts.push("pele oleosa");
      if (pele.includes("seca")) parts.push("pele seca");
      if (pele.includes("sens")) parts.push("pele sensível");
      if (pele.includes("mista")) parts.push("pele mista");

      if (sens.includes("alta")) parts.push("sensível");
      if (textura.includes("gel")) parts.push("gel");
      if (textura.includes("crem")) parts.push("creme");

      const incTxt = inc.join(" ").toLowerCase();
      if (incTxt.includes("oleos")) parts.push("controle de oleosidade");
      if (incTxt.includes("acne")) parts.push("acne");
      if (incTxt.includes("poros")) parts.push("poros");
      if (incTxt.includes("manchas")) parts.push("clareador");
      if (incTxt.includes("linhas")) parts.push("anti-idade");
      if (incTxt.includes("olheiras")) parts.push("olhos");

      // Se não usa protetor, prioriza FPS em um dos itens
      if (baseTerm.includes("protetor") || baseTerm.includes("fps")) {
        parts.push("FPS");
      }

      return parts.join(" ");
    }

    // 5 slots fixos para rotina facial
    const slots = [
      { label: "Limpeza", term: "gel de limpeza" },
      { label: "Hidratação", term: "hidratante facial" },
      { label: "Proteção", term: "protetor solar facial fps" },
      { label: "Tratamento", term: "sérum facial" },
      { label: "Extra", term: "tônico facial" }, // pode virar esfoliante dependendo do perfil
    ];

    // Ajuste do 5º slot conforme rotina/necessidade
    const incTxt = inc.join(" ").toLowerCase();
    if (incTxt.includes("manchas") || incTxt.includes("linhas")) {
      slots[4] = { label: "Extra", term: "vitamina c facial" };
    } else if (incTxt.includes("oleos") || incTxt.includes("poros") || incTxt.includes("acne")) {
      slots[4] = { label: "Extra", term: "esfoliante facial" };
    } else if (sens.includes("alta") || pele.includes("sens")) {
      slots[4] = { label: "Extra", term: "água micelar" };
    }

    // ===================== Busca e ranking =====================
    function scoreProduct(p, slotTerm) {
      let s = 0;
      const name = (p.nome || "").toLowerCase();

      if (isForbidden(name)) return -Infinity;
      if (p._out) return -Infinity;

      // deve ser face/skincare (senão derruba)
      if (!isFaceProduct(name)) s -= 8;
      else s += 2;

      // match do slot
      const firstWord = (slotTerm || "").toLowerCase().split(/\s+/)[0];
      if (firstWord && name.includes(firstWord)) s += 2.0;

      // match pele/objetivos
      if (pele.includes("oleos") && (name.includes("oleos") || name.includes("controle"))) s += 1.2;
      if (pele.includes("seca") && (name.includes("hidrat") || name.includes("nutri"))) s += 1.0;
      if ((sens.includes("alta") || pele.includes("sens")) && (name.includes("sens") || name.includes("calm") || name.includes("suave"))) s += 1.0;

      if (incTxt.includes("manchas") && (name.includes("vitamina") || name.includes("c") || name.includes("clare"))) s += 1.0;
      if (incTxt.includes("acne") && (name.includes("acne") || name.includes("salic") || name.includes("niacin"))) s += 1.0;

      // imagem e link
      if (p.foto && isHttps(p.foto)) s += 0.5;
      if (isValidProductUrl(p.onde_comprar)) s += 0.8;

      // preço existe
      if (p.preco > 0) s += 0.3;
      else s -= 2.0;

      return s;
    }

    // Coleta resultados dos 5 slots (cada slot faz 1 busca)
    const all = [];
    for (const slot of slots) {
      const q = buildQuery(slot.term);
      const list = await opaqueSearch(q);

      list.forEach(p => {
        all.push({
          ...p,
          _slot: slot.label,
          _term: slot.term,
          _score: scoreProduct(p, slot.term),
        });
      });
    }

    // Filtra apenas produtos realmente válidos
    const candidates = all
      .filter(p => p && p._score > -Infinity)
      .filter(p => isValidProductUrl(p.onde_comprar))
      .filter(p => !isForbidden(p.nome))
      .filter(p => p.preco > 0); // Face: exige preço para respeitar orçamento

    // ===================== Orçamento: tenta faixa escolhida, se não der, sobe para a próxima =====================
    const ladder = budgetLadderFromSelection(answers?.orcamento);
    let chosenRange = ladder[0];
    let pool = [];

    for (let i = 0; i < ladder.length; i++) {
      const r = ladder[i];
      const within = candidates.filter(p => inBudget(p.preco, r.min, r.max));
      if (within.length >= 5) {
        chosenRange = r;
        pool = within;
        break;
      }
      // se for a última faixa e mesmo assim não tem 5, pega o que tiver nessa faixa e completa depois
      if (i === ladder.length - 1) {
        chosenRange = r;
        pool = within;
      }
    }

    // Se mesmo na última faixa não tiver 5, completa com os mais baratos acima de 0 (garante produto)
    if (pool.length < 5) {
      const extra = candidates
        .filter(p => !pool.some(x => x.onde_comprar === p.onde_comprar))
        .sort((a,b) => a.preco - b.preco);
      pool = pool.concat(extra);
    }

    // Ainda assim, se candidates veio muito baixo (raro), tenta sem filtro de FACE_KEYWORDS
    if (pool.length < 5) {
      // fallback absoluto: busca genérica dentro de face
      const fallbackList = await opaqueSearch("facial");
      const fallbackNorm = fallbackList
        .filter(p => p && p.nome && p.preco > 0)
        .filter(p => !p._out)
        .filter(p => isValidProductUrl(p.onde_comprar));

      const extra2 = fallbackNorm
        .filter(p => !pool.some(x => x.onde_comprar === p.onde_comprar))
        .sort((a,b) => a.preco - b.preco);

      pool = pool.concat(extra2);
    }

    // Ranking final e dedupe
    const seen = new Set();
    const ranked = pool
      .sort((a,b) => b._score - a._score)
      .filter(p => {
        if (!p.onde_comprar) return false;
        if (seen.has(p.onde_comprar)) return false;
        seen.add(p.onde_comprar);
        return true;
      });

    // Seleção final: tenta diversidade por slot (um por slot)
    const bySlot = new Map();
    for (const item of ranked) {
      if (!bySlot.has(item._slot)) bySlot.set(item._slot, item);
    }

    const picked = [];
    for (const slot of slots) {
      const p = bySlot.get(slot.label);
      if (p) picked.push(p);
    }

    // Completa até 5 com os melhores restantes
    let idx = 0;
    while (picked.length < 5 && idx < ranked.length) {
      const p = ranked[idx++];
      if (!p) break;
      if (picked.some(x => x.onde_comprar === p.onde_comprar)) continue;
      picked.push(p);
    }

    // Se ainda faltar (muito raro), cria “itens genéricos” apontando para categoria — MAS NÃO em products.
    // Aqui a regra é: SEMPRE retornar produto. Então vamos forçar uma última busca por “protetor solar facial”
    if (picked.length < 5) {
      const lastTry = await opaqueSearch("protetor solar facial");
      for (const p of lastTry) {
        if (picked.length >= 5) break;
        const ok = p && p.nome && p.preco > 0 && !p._out && isValidProductUrl(p.onde_comprar);
        if (!ok) continue;
        if (picked.some(x => x.onde_comprar === p.onde_comprar)) continue;
        picked.push(p);
      }
    }

    // ✅ Se mesmo assim não alcançou 5, retorna erro explícito (para você ver no frontend)
    if (picked.length < 1) {
      return res.status(502).json({
        error: "Busca na Opaque retornou zero produtos válidos após filtros.",
      });
    }

    // Mensagem se precisou subir faixa
    const selectedLabel = (answers?.orcamento || "").toString();
    let message = "";
    if (selectedLabel && chosenRange) {
      const [selMin, selMax] = parseBudgetRange(selectedLabel);
      if (selMin !== chosenRange.min || selMax !== chosenRange.max) {
        message =
          `Não encontramos 5 produtos dentro do orçamento selecionado (${selectedLabel}). ` +
          `Mostrando produtos na próxima faixa disponível (${chosenRange.label}).`;
      }
    }

    function benefitsFor(p) {
      const n = (p.nome || "").toLowerCase();
      const b = [];
      if (n.includes("limp") || n.includes("clean") || n.includes("micelar")) b.push("Ajuda a remover impurezas do dia a dia");
      if (n.includes("hidrat") || n.includes("moist") || n.includes("hialur")) b.push("Hidratação para pele mais equilibrada");
      if (n.includes("fps") || n.includes("solar") || n.includes("protet")) b.push("Proteção diária contra raios UV");
      if (n.includes("vitamina") || n.includes("c")) b.push("Auxilia no viço e uniformidade");
      if (n.includes("serum") || n.includes("sérum")) b.push("Tratamento com textura leve para rotina");
      if (n.includes("esfol") || n.includes("peeling")) b.push("Renovação suave (use com moderação)");
      if (b.length === 0) b.push("Combina com seu perfil e rotina de cuidados faciais");
      return b.slice(0, 4);
    }

    const products = picked.slice(0, 5).map((p, i) => {
      const foto = isHttps(p.foto) ? p.foto : FACE_FALLBACK_IMGS[i % FACE_FALLBACK_IMGS.length];
      const urlAff = addAffiliate(p.onde_comprar);

      return {
        id: ("opaque-face-" + Buffer.from(p.onde_comprar).toString("base64")).replace(/=+$/, ""),
        nome: p.nome,
        marca: p.marca || "Opaque",
        preco: toBRL(p.preco || 0),
        foto,
        beneficios: benefitsFor(p),
        motivo: `Selecionado para sua rotina facial (passo: ${p._slot}).`,
        onde_comprar: urlAff,
      };
    });

    return res.json({
      products,
      message,
      budget_used: chosenRange ? { label: chosenRange.label, min: chosenRange.min, max: chosenRange.max } : null,
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
