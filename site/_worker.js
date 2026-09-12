// Cloudflare Pages — custom Worker (root _worker.js)
//
// The dashboard's drag-and-drop upload does NOT compile a `functions/`
// directory into Pages Functions (that only works via the Wrangler CLI).
// A root-level `_worker.js`, however, IS supported by drag-and-drop and
// takes full control of every request, so it is used here instead:
// it serves the static site via `env.ASSETS.fetch()` for everything except
// POST /api/chat, which it handles itself.
//
// The Anthropic API key never reaches the browser: it lives only as the
// ANTHROPIC_API_KEY secret in this Pages project's settings, read here
// server-side via `env`.
//
// Required project settings (Cloudflare dashboard → Pages project →
// Settings → Environment variables):
//   ANTHROPIC_API_KEY  (secret, required)  — from console.anthropic.com
//   ANTHROPIC_MODEL    (plain var, optional) — defaults below; check
//                       https://docs.claude.com/en/docs/about-claude/models
//                       for the current model id and update if needed.

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const MAX_TOKENS = 1024;
const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 4000;

// ---------------------------------------------------------------
// Layer 1+2: CORE knowledge — shared by every future tenant.
// Keep this generic. No tenant-private deal data belongs here.
// ---------------------------------------------------------------
const CORE_INSTRUCTIONS = [
  "You are Alla, an AI real estate and investment advisor. You think like an ",
  "investment analyst, not a listings search engine: for every property, plot, ",
  "or deal someone raises, default to surfacing the full cost of entry (price + ",
  "taxes + notary + registration + renovation/construction if relevant), the ",
  "realistic exit value, and the risks that could change either number.\n\n",
  "Core expertise, apply proactively without waiting to be asked:\n",
  "- Legal intelligence: assess document completeness and legal risk (ownership ",
  "type, registration, zoning compliance) for a property or plot.\n",
  "- Tax assessment: explain which taxes apply to a purchase, sale, or ongoing ",
  "ownership (transfer tax/ITP, VAT/IVA, stamp duty/AJD, IBI, plusvalía) based ",
  "on buyer profile (resident/non-resident/company) and region. Give the ",
  "framework and typical ranges; say plainly when an exact current rate needs ",
  "local verification instead of inventing a number.\n",
  "- Urban planning & buildability: read informes urbanísticos / cadastral data ",
  "and translate them into buildable m², licensing path, and red flags ",
  "(edificabilidad, ocupación, retranqueos, height limits, protected status).\n",
  "- Investment strategy: model multiple ownership strategies side by side, not ",
  "just one — buy → build/reform → sell (flip); buy → hold → let (rental yield, ",
  "cash-on-cash return, appreciation over a holding period); and staged/hybrid ",
  "paths (buy → let for N years → sell; buy → reform → let → sell later). For ",
  "any staged strategy, model the entry (acquisition + taxes + reform), the ",
  "holding phase (rental income net of costs/taxes/vacancy, and how a specific ",
  "exit year changes the return), and the exit (realistic sale price and its own ",
  "taxes/costs) — and compare strategies against each other on the same deal, ",
  "not just describe one. Also compare locations by liquidity, demand, and ",
  "zoning constraints.\n",
  "- Sublease / subarenda strategy: judge commercial premises for sublease ",
  "potential — first-line street visibility, an open rectangular floor plan, ",
  "sufficient electrical capacity, room to negotiate a rent-free period, a ",
  "plain rental listing ('alquiler') rather than one requiring a 'traspaso' ",
  "payment — and reason through the economics of subdividing a space into ",
  "smaller units for re-letting, plus the legal basis (Spanish LAU rental law, ",
  "right to sublet, licencia de actividad, cambio de uso).\n",
  "- Property identification & real cadastral lookup: you have a live tool, ",
  "catastro_lookup, that queries Spain's official Sede Electrónica del ",
  "Catastro (the free public service, not a paid data source) for a specific ",
  "address or cadastral reference. Use it whenever someone gives you a concrete ",
  "address, plot, or referencia catastral and wants real facts about it — don't ",
  "guess when you can look it up. It returns REAL government data only: ",
  "cadastral reference, address, plot/built surface area, land-use class, and ",
  "construction year where available — report only fields it actually returned, ",
  "never fill a gap with an invented figure. It explicitly does NOT return ",
  "buildable percentage, height limits, setbacks, or other urbanistic planning ",
  "norms (edificabilidad, ocupación, altura, retranqueos, usos permitidos) — ",
  "those live in each municipality's own planning instrument (PGOU/normas ",
  "subsidiarias) and are not centrally digitized across Spain's roughly 8,100 ",
  "municipalities. After giving the real cadastral facts from the tool, always ",
  "name the specific correct next step for the planning norms themselves: point ",
  "to that municipality's ayuntamiento/urbanismo (planning) department, and, ",
  "where you know of an actual working regional geoportal, name it specifically ",
  "— e.g. IDEIB (ideib.caib.es) for the Balearic Islands — rather than a vague ",
  "'check locally.' Never state a specific edificabilidad %, height limit, or ",
  "other planning figure you did not get from the tool result or from the ",
  "person themselves — that line does not move even when someone pushes for a ",
  "number. If the tool fails or the query doesn't resolve, say so plainly and ",
  "fall back to walking the person through looking it up themselves at ",
  "sedecatastro.gob.es, exactly as before this tool existed.\n",
  "- Analytical document generation: when asked, produce a full feasibility ",
  "memorandum / investment analysis as structured text in the chat, in this ",
  "order — Executive Summary with a key-metrics table; Asset Description; ",
  "Acquisition Cost breakdown; Construction/Reform Budget with a cost-",
  "sensitivity range; Timeline; Market Comparables (built from data the person ",
  "supplies); Profitability Scenarios as a sensitivity table across exit prices ",
  "and cost scenarios; Risks & Open Items pending due diligence; and a closing ",
  "disclaimer that the figures are estimates, not binding advice. Base every ",
  "number on what the person has given you or already confirmed — never invent ",
  "a comparable, cost, or market figure to fill a gap.\n\n",
  "When evaluating a property or plot as an investment, work through it as a ",
  "structured checklist rather than a vibe: price per m² against the ",
  "neighbourhood and region (and say if you don't have a reliable comparable), ",
  "realistic time-to-sell and demand level, rental yield if let (gross and ",
  "net of taxes/costs, occupancy-adjusted), what staging/furnishing/light ",
  "renovation could realistically add versus its cost, and for a plot or ",
  "building: buildable area, occupancy %, height/floors, and setbacks — the ",
  "same edificabilidad / ocupación / altura / retranqueos categories a Spanish ",
  "informe urbanístico reports. For comparables (price/m², rental levels, time- ",
  "on-market), use whatever the person gives you — listings or figures they ",
  "paste in from portals such as idealista or Fotocasa, or numbers they already ",
  "have — and reason from those; never invent a comparable price or portal ",
  "figure yourself. Populate this checklist with the person's own numbers and ",
  "publicly reasoned estimates, not invented regional averages.\n\n",
  "If someone works professionally as an agent, they may need to be listed on ",
  "a regional registry to operate legally — AICAT in Catalonia (via the ",
  "Agència de l'Habitatge de Catalunya, agenciahabitatge.gencat.cat) and ",
  "ROAIIB in the Balearic Islands (via the Govern balear, ",
  "caib.es/sites/agentsimmobiliaris). Mention this when relevant, but don't ",
  "quote a specific fee, fine, or hour requirement unless you're confident in ",
  "it — point to the official registry instead of guessing a number.\n\n",
  "You are not a mortgage broker. If asked about financing, give general ",
  "orientation only (how LTV/eligibility generally works) and say a dedicated ",
  "lender comparison isn't connected yet — never estimate a specific bank's ",
  "approval odds or rate.\n\n",
  "Geography: you cover Spain nationwide — national-level tax and legal ",
  "frameworks apply everywhere, and you can reason about any region. Your ",
  "deepest, most detailed expertise is the Balearic Islands (Menorca, Ibiza, ",
  "Mallorca) — municipal-level zoning (PGOU), tourist licensing, the ",
  "non-resident buyer market. For the other 16 autonomous communities and 2 ",
  "autonomous cities, reason from the three-tier structure that always applies ",
  "(national land law → regional urbanism law → municipal PGOU/normas ",
  "subsidiarias) and from the catastro_lookup tool's real facts, but treat ",
  "region-specific detail beyond that as something to build up over time, not ",
  "something you already hold — always flag that tax and zoning rules vary by ",
  "region and municipality, and be upfront when a question needs local ",
  "verification beyond what you're confident in.\n\n",
  "Language: reply in the language the person writes in — detect automatically, ",
  "never ask which language to use. Tone: precise, warm, a trusted advisor ",
  "rather than a bare calculator — lead with numbers when you have them.\n\n",
  "Never fabricate a specific current tax rate, bank condition, or legal fact ",
  "you aren't confident in — name what you'd need to check instead, and say so ",
  "before anything that would guide a real decision with money attached. Keep ",
  "this conversation's information separate from any other conversation's."
].join("");

// ---------------------------------------------------------------
// Tenant overlay — swap this block (and only this block) to stand
// up Alla for a different agency later. Tenant #1 = ROILITY.
// ---------------------------------------------------------------
const TENANT_OVERLAY = [
  "You are being used by ROILITY, S.L., a real-estate investment and ",
  "development agency based in the Balearic Islands. Sign off as Alla, from ",
  "ROILITY, when it feels natural — not in every message. If someone wants to ",
  "go further than a conversation (see a specific property, get a feasibility ",
  "figure modeled properly, talk to a person), invite them to leave what ",
  "they're looking for and how to reach them, and say the team will follow up ",
  "— don't claim to have booked or sent anything, there is no live CRM ",
  "connection yet.\n\n",
  "House style for feasibility memoranda: when you produce one for ROILITY, ",
  "head it 'ROILITY S.L. — Real Estate Investment & Development — Balearic ",
  "Islands', mark it 'Prepared by ROILITY S.L. for internal use of the ",
  "promoter', and close with 'CONFIDENTIAL — Working document, does not ",
  "constitute an offer or financial/tax advice.' Keep the section order and ",
  "tone from the core analytical-document format — precise, numbers-led, no ",
  "sales language."
].join("");

const SYSTEM_PROMPT = CORE_INSTRUCTIONS + "\n\n---\n\n" + TENANT_OVERLAY;

// ---------------------------------------------------------------
// Cadastre lookup tool — real, live queries against Spain's free
// public Catastro web service (Sede Electrónica del Catastro).
// Endpoints and parameter names confirmed against the service's own
// published documentation (Servicios web libres v2.6) and the
// third-party pycatastro library, which wraps the same operations.
//
// IMPORTANT / not yet live-verified: this session could not reach
// ovc.catastro.meh.es directly (sandboxed outbound network here is
// allowlisted and does not include it), and the one check possible
// via a fetch proxy returned the service's own "scheduled maintenance"
// error rather than real parcel data. The endpoint, operation names,
// and parameters below are real and documented, but the exact JSON
// response shape has not been confirmed against a live successful
// response in this session. Cloudflare Workers have open outbound
// networking, so this should work once deployed — but run one real
// lookup against a known address right after deploying and sanity
// check the result before relying on it in front of a real user.
// ---------------------------------------------------------------
const CATASTRO_BASE =
  "http://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCallejero.svc/json/";

const CATASTRO_TOOL = {
  name: "catastro_lookup",
  description:
    "Looks up real, official Spanish cadastral data for one parcel or building " +
    "via Spain's free public Sede Electrónica del Catastro web service. Returns " +
    "only real facts actually present in the response: cadastral reference, " +
    "address, plot/built surface area (m2), land-use class, and construction " +
    "year where available. It does NOT return buildable percentage, height " +
    "limits, or any other urbanistic planning norm (edificabilidad, ocupacion, " +
    "altura, retranqueos, usos permitidos) — those are not part of Catastro's " +
    "data and must never be inferred from this tool's result. Call this " +
    "whenever the person gives a specific Spanish address or a referencia " +
    "catastral and wants real facts about that parcel, instead of guessing. " +
    "Provide either referencia_catastral, or nombre_via + numero, together " +
    "with provincia and municipio.",
  input_schema: {
    type: "object",
    properties: {
      provincia: {
        type: "string",
        description: "Province name as Catastro expects it, e.g. BALEARES, MADRID, VALENCIA."
      },
      municipio: {
        type: "string",
        description: "Municipality name as Catastro expects it, e.g. MERCADAL, PALMA DE MALLORCA."
      },
      referencia_catastral: {
        type: "string",
        description: "Full or partial cadastral reference, if the person already has one (from a listing or informe urbanistico). Use this OR the street fields below, not both."
      },
      tipo_via: {
        type: "string",
        description: "Street-type abbreviation Catastro uses, e.g. CL (calle), AV (avenida), CM (camino), PZ (plaza), CR (carretera). Optional."
      },
      nombre_via: {
        type: "string",
        description: "Street name, without the type prefix. Required if referencia_catastral isn't given."
      },
      numero: {
        type: "string",
        description: "Street number. Required if referencia_catastral isn't given."
      }
    },
    required: ["provincia", "municipio"]
  }
};

// Cheap heuristic gate: most chat turns are general advice and should keep
// the original single-call streaming path unchanged (fast, no added
// latency). Only turns that plausibly need a real cadastral fact go through
// the slower tool-enabled round trip below.
function looksLikeCadastreQuery(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return /catastr|referencia\s+catastral|idealista\.[a-z]+\/inmueble|\bparcela\b|\bsolar\b|edificabilidad|urban[ií]stic|cadastral|cadastre/i.test(
    t
  );
}

async function runCatastroTool(input) {
  input = input || {};
  const provincia = String(input.provincia || "").trim();
  const municipio = String(input.municipio || "").trim();
  let op, params;

  if (input.referencia_catastral) {
    op = "Consulta_DNPRC";
    params = { Provincia: provincia, Municipio: municipio, RC: String(input.referencia_catastral).trim() };
  } else if (input.nombre_via && input.numero) {
    op = "Consulta_DNPLOC";
    params = {
      Provincia: provincia,
      Municipio: municipio,
      Sigla: String(input.tipo_via || "").trim(),
      Calle: String(input.nombre_via).trim(),
      Numero: String(input.numero).trim()
    };
  } else {
    return {
      error: "insufficient_input",
      message: "Need either referencia_catastral, or nombre_via + numero, along with provincia and municipio."
    };
  }

  const url = CATASTRO_BASE + op + "?" + new URLSearchParams(params).toString();
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const raw = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = { unparsed_response: raw.slice(0, 4000) };
    }
    return {
      source: "Sede Electronica del Catastro (free public service; not a legally certified extract)",
      operation: op,
      http_status: res.status,
      result: parsed
    };
  } catch (e) {
    return { error: "fetch_failed", message: String((e && e.message) || e) };
  }
}

// Builds a synthetic Anthropic-shaped SSE stream from a completed
// (non-streaming) Messages API response, so the existing browser-side SSE
// parser — built against Anthropic's real stream format — keeps working
// unchanged for the tool-enabled path too. Text arrives as one delta per
// block rather than token-by-token; everything else (event names, field
// shapes) mirrors the real stream.
function syntheticSSEFromMessage(data) {
  const enc = new TextEncoder();
  const lines = [];
  const push = (event, obj) => {
    lines.push("event: " + event + "\n");
    lines.push("data: " + JSON.stringify(obj) + "\n\n");
  };

  push("message_start", {
    type: "message_start",
    message: {
      id: data.id,
      type: "message",
      role: "assistant",
      model: data.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: data.usage || {}
    }
  });

  const blocks = Array.isArray(data.content) ? data.content : [];
  let index = 0;
  for (const block of blocks) {
    if (block.type !== "text") continue; // tool_use blocks never reach here (see handleChatPost)
    push("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
    push("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: block.text || "" }
    });
    push("content_block_stop", { type: "content_block_stop", index });
    index++;
  }

  push("message_delta", {
    type: "message_delta",
    delta: { stop_reason: data.stop_reason || "end_turn", stop_sequence: null },
    usage: data.usage || {}
  });
  push("message_stop", { type: "message_stop" });

  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line));
      controller.close();
    }
  });
}

function jsonError(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function handleChatPost(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonError(500, "server_not_configured");
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonError(400, "invalid_json");
  }

  const incoming = Array.isArray(body && body.messages) ? body.messages : null;
  if (!incoming || incoming.length === 0) {
    return jsonError(400, "missing_messages");
  }

  // Sanitize: keep only role/content, cap length and history size, and make
  // sure roles alternate user/assistant starting with user (Anthropic's
  // Messages API requirement) — drop anything malformed rather than 500ing.
  const cleaned = [];
  for (const m of incoming.slice(-MAX_HISTORY_MESSAGES)) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    if (typeof m.content !== "string" || !m.content.trim()) continue;
    const content = m.content.slice(0, MAX_MESSAGE_CHARS);
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.role === m.role) {
      // merge consecutive same-role turns instead of sending an invalid sequence
      prev.content += "\n\n" + content;
    } else {
      cleaned.push({ role: m.role, content });
    }
  }
  if (cleaned.length === 0 || cleaned[0].role !== "user") {
    return jsonError(400, "invalid_history");
  }

  const model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const lastUserMessage = [...cleaned].reverse().find((m) => m.role === "user");
  const useCadastreTool = looksLikeCadastreQuery(lastUserMessage && lastUserMessage.content);

  if (!useCadastreTool) {
    // Original fast path: single streamed call, no tools. Unchanged from
    // before this session's cadastre-lookup work so the common case (general
    // advice, no specific parcel/address) keeps its original low latency.
    let anthropicRes;
    try {
      anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          stream: true,
          messages: cleaned
        })
      });
    } catch (e) {
      return jsonError(502, "upstream_unreachable");
    }

    if (!anthropicRes.ok || !anthropicRes.body) {
      let detail = "upstream_error";
      try {
        const errBody = await anthropicRes.json();
        if (errBody && errBody.error && errBody.error.message) detail = errBody.error.message;
      } catch (e) { /* ignore */ }
      return jsonError(anthropicRes.status || 502, detail);
    }

    // Stream Anthropic's SSE response straight through to the browser —
    // the client parses content_block_delta events itself.
    return new Response(anthropicRes.body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      }
    });
  }

  // Tool-enabled path: the message plausibly needs a real cadastral fact.
  // Non-streaming round trip(s) so we can see and execute a tool_use block
  // before answering, capped so a confused model can never loop forever;
  // the FINAL answer (tool-informed or not) is what reaches the browser,
  // reconstructed as a real-shaped SSE stream (see syntheticSSEFromMessage).
  let messages = cleaned.slice();
  const MAX_TOOL_ROUNDS = 3;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          tools: [CATASTRO_TOOL],
          messages
        })
      });
    } catch (e) {
      return jsonError(502, "upstream_unreachable");
    }

    if (!res.ok) {
      let detail = "upstream_error";
      try {
        const errBody = await res.json();
        if (errBody && errBody.error && errBody.error.message) detail = errBody.error.message;
      } catch (e) { /* ignore */ }
      return jsonError(res.status || 502, detail);
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      return jsonError(502, "upstream_invalid_json");
    }

    if (data.stop_reason !== "tool_use") {
      // Final answer — reconstruct it as a real-shaped SSE stream.
      return new Response(syntheticSSEFromMessage(data), {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
      });
    }

    // Execute every tool_use block in this turn, then loop so Claude can
    // answer using the results (or ask for one more lookup, up to the cap).
    const toolUseBlocks = (data.content || []).filter((b) => b.type === "tool_use");
    messages.push({ role: "assistant", content: data.content });

    const toolResults = [];
    for (const block of toolUseBlocks) {
      const result = await runCatastroTool(block.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result).slice(0, 8000)
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // Exhausted the round cap without a final answer (shouldn't normally
  // happen) — fall back to one plain streamed call, no tools, rather than
  // ever leaving the user stuck with nothing.
  let fallbackRes;
  try {
    fallbackRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, stream: true, messages: cleaned })
    });
  } catch (e) {
    return jsonError(502, "upstream_unreachable");
  }
  if (!fallbackRes.ok || !fallbackRes.body) {
    return jsonError(fallbackRes.status || 502, "upstream_error");
  }
  return new Response(fallbackRes.body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/chat") {
      if (request.method === "POST") {
        return handleChatPost(request, env);
      }
      return jsonError(405, "method_not_allowed");
    }

    // Everything else: serve the static site as normal.
    return env.ASSETS.fetch(request);
  }
};
