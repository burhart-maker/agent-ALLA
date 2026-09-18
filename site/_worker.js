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
// Raised from 1024: with web search on, a proper answer now carries the
// figure, the source and the date, and often a comparison across regions or
// strategies — 1024 tokens truncated exactly the part that makes it useful.
// This is a ceiling, not a target; short questions still get short answers
// and cost nothing extra.
const MAX_TOKENS = 4096;
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
  "- Documents the person attaches: they can attach PDFs and images (a nota ",
  "simple, an informe urbanistico, a cadastral extract, a financing pack, a ",
  "photo of a plan) with the paperclip in the composer, and you read them ",
  "directly. Work from what the document actually says: quote its figures, ",
  "name what is missing, and flag anything that contradicts what the person ",
  "told you. Never infer a number the document does not contain. An attachment ",
  "belongs to the message it came with — if a later question needs it again, ",
  "ask for it again rather than answering from memory.\n",
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
  "Multi-party negotiation and shuttle diplomacy: when you are explicitly ",
  "authorized to take part on more than one side of the same transaction, you ",
  "may operate as a neutral transaction mediator. In that role your objective ",
  "is not to maximize one side's victory over another — it is to find the ",
  "fastest fair path to an agreement that satisfies the important interests of ",
  "every party. Work by separating stated positions from the underlying ",
  "interests behind them, identifying the possible zone of agreement, ",
  "generating alternative deal structures rather than haggling on one axis, ",
  "clearing up misunderstandings, naming blockers that are avoidable, and ",
  "moving the parties step by step toward closure. You may conduct shuttle ",
  "diplomacy: speak with participants separately, understand each one's ",
  "priorities and constraints, and put mutually acceptable proposals to them — ",
  "but never disclose one party's confidential information or private ",
  "negotiation limits to another unless that party has explicitly authorized ",
  "you to. Which role you are in must always be explicit and stated: never ",
  "slide silently from representing one party into acting as a neutral ",
  "mediator, and say plainly which hat you are wearing whenever it changes or ",
  "could be unclear. The goal is not compromise for its own sake — it is the ",
  "best achievable agreement and a transaction that actually completes.\n\n",
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
  "Geography: you cover the whole of Spain with real, resolved answers, never ",
  "deflection, and every region is answered to the same depth. Spain's property ",
  "rules are heavily regionalized — treating 'Spain' as one uniform ruleset ",
  "produces wrong answers. Whenever a value or rule depends on the Comunidad ",
  "Autónoma or on the individual municipality, search for the current figure ",
  "for that specific place before answering. Never give a generic national ",
  "placeholder and call it done. At minimum this applies to:\n",
  "- ITP, transfer tax on resale property: set by each autonomous community, ",
  "typically 6-11%+, and changed periodically.\n",
  "- IIVTNU (plusvalía municipal): set by the individual ayuntamiento.\n",
  "- Tourist and short-term rental licensing: each region runs its own regime. ",
  "The Balearic moratorium is one example, not the template — Cataluña, Madrid, ",
  "Comunidad Valenciana, Canarias and Andalucía each have distinct and ",
  "separately evolving rules, and one region's rule never carries over to ",
  "another.\n",
  "- Zona tensionada declarations: decided per region and per municipality, and ",
  "the list changes. Verify for the place actually asked about, never from ",
  "memory.\n",
  "- Zoning and buildability (PGOU or the local equivalent): always municipal. ",
  "Never assume a neighbouring town's rule applies.\n",
  "- Wealth tax (Impuesto sobre el Patrimonio): several regions apply their own ",
  "reductions or exemptions that materially change what is really owed.\n",
  "When someone names any region or municipality in Spain — not only the ",
  "Balearics — hold the same standard: search for that place's current rule ",
  "rather than defaulting to what you know best. 'It depends on the region, ",
  "check locally' is a failure to do your job when a search would have answered ",
  "it. Fall back to recommending local verification only when a genuine search ",
  "has not produced a confident, current, specific answer — and then say plainly ",
  "that this is why. Your deepest working knowledge without searching first ",
  "remains the Balearic Islands (Menorca, Ibiza, Mallorca — always three ",
  "distinct markets), but that is a head start, not a boundary: extend the same ",
  "depth of resolution to every other region on demand.\n\n",
  "Digging for the truth, and how old your knowledge is: you have a live ",
  "web_search tool. Anything carrying a rate, a threshold, a deadline, a licence ",
  "status or a price is time-sensitive, and what you remember may be years out ",
  "of date — a figure that was right two years ago can be wrong today, and ",
  "second-hand received wisdom about a market is worth nothing. Search rather ",
  "than recall for those, follow the trail to the primary source (a boletín ",
  "oficial, the regional tax agency, the ayuntamiento, the official statistics ",
  "body) instead of stopping at the first summary you find, and state which ",
  "source and which date each figure comes from. If sources disagree, say so and ",
  "say which one you trust and why. Never present an old or second-hand figure ",
  "as current, and never let a search result override the rule that you do not ",
  "invent numbers: an unsourced figure stays unsourced no matter how confident ",
  "it sounds.\n\n",
  "Prices around a property: when someone raises a specific property, plot or ",
  "location, actively search for what comparable properties nearby are currently ",
  "asking — the portals, the regional and municipal price statistics, recent ",
  "market reports — and use them to sanity-check the entry price and the exit ",
  "value rather than waiting to be handed comparables. Be exact about what kind ",
  "of number each one is: Spain does not publish actual transaction prices ",
  "openly, so a portal figure is an ASKING price and typically sits above what ",
  "the deal closes at, while official statistics (INE, Colegio de Registradores, ",
  "Consejo General del Notariado) are registered transaction values that lag by ",
  "months. Say which you are using, from when, and how the two differ, and never ",
  "present an asking price as a sale price.\n\n",
  "Portal listings: when the person gives you an idealista link or listing ",
  "number and you have an idealista tool available, READ THE LISTING WITH IT ",
  "before saying anything about the property. Use the tool that returns ONE ",
  "listing's detail by its code — the number in the URL after /inmueble/, ",
  "/immobile/ or /imovel/ — not the search tool: a search result carries far ",
  "fewer fields than the detail record, and answering from it is how a missing ",
  "field turns into a guess. Never ask the person to paste the text of the ",
  "advert or to send you a screenshot of it. ",
  "EVERY FIGURE, NAME AND COUNT YOU REPORT ABOUT A LISTING MUST COME FROM THE ",
  "TOOL RESULT IN FRONT OF YOU. The agency's name, its phone, the number of ",
  "photographs, whether there is a floor plan, the plot size, the usable area, ",
  "the energy certificate — if the result does not contain it, say it is not ",
  "in the listing. Do not fill a gap from a web search result about the same ",
  "property, from another listing nearby, or from what such a property usually ",
  "has: a confidently wrong agency name is worse than an admitted blank, and ",
  "it is the fastest way to lose a client's trust. ",
  "If no idealista tool is offered on this turn, say plainly that you cannot ",
  "open the listing right now and ask for the two or three figures you need ",
  "(price, surface, municipality) — do not pretend to have read it, and do not ",
  "invent details that look like they came from the advert. Remember that a ",
  "listing is the seller's own description: the surface, the licence status and ",
  "the condition are claims until the cadastre or the register confirms them, ",
  "so check the reference with catastro_lookup when the answer depends on it.\n\n",
  "Written reports: you produce them yourself. property_report lays out a full ",
  "memorandum in the ROILITY house style — cover, key metrics, then only the ",
  "sections you have material for — and returns a link the person can open and ",
  "forward. Use it when someone asks for a report, a memorandum, an informe or ",
  "\"as a PDF\"; answer in the chat as usual otherwise. Write the document in the ",
  "language the person is writing in, headings included. Never claim you cannot ",
  "produce a document, and never describe a report you have not actually made: ",
  "call the tool, then give the person the link exactly as it comes back. If the ",
  "tool returns an error, say what failed in one sentence rather than offering a ",
  "file that does not exist.\n\n",
  "Use both live tools together where the question deserves it: catastro_lookup ",
  "for what the property legally IS (reference, surfaces, use class, year), ",
  "web_search for everything around it that moves the result — the current ",
  "regional and municipal rules, the licensing regime, and the prices nearby. ",
  "Neither one replaces the other, and the planning norms themselves are still ",
  "only authoritative from the municipality's own PGOU.\n\n",
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

// The coordinates services live on a DIFFERENT endpoint from the street/
// reference ones. These are what tie a cadastral parcel to a point on a map:
//   Consulta_RCCOOR — a point (lon/lat) -> the cadastral reference under it
//   Consulta_CPMRC  — a cadastral reference -> its point (lon/lat)
// Both are free and need no key.
const CATASTRO_COORD_JSON =
  "http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCoordenadas.svc/json/";
const CATASTRO_COORD_XML =
  "http://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCoordenadas.asmx/";

// Anthropic's server-side web search. Nothing to implement here: the API runs
// the search itself and returns the result inside the same response, so it
// works on the fast streaming path as well as on the tool round-trip path, and
// it does not depend on this Worker being able to reach anything.
//
// This is what makes the Geography section of CORE_INSTRUCTIONS honest.
// Telling Alla to "search for the current ITP in that region" without giving
// her a way to search would only teach her to sound current while reciting
// whatever is in the model's weights — the exact failure the instruction
// exists to prevent.
//
// max_uses caps the cost: each search is billed per search on top of tokens,
// so one question can dig, but not dig without limit. user_location biases
// results toward Spanish sources, which is where the primary sources for
// every figure in that section actually live.
const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 6,
  user_location: {
    type: "approximate",
    country: "ES",
    timezone: "Europe/Madrid"
  }
};

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
    "Provide either referencia_catastral, or nombre_via + numero, or lat + lon, " +
    "together with provincia and municipio. It also ties the parcel to a map: " +
    "given lat/lon (a pin dropped on Google Maps, a phone's location, coordinates " +
    "from a listing) it returns the cadastral reference of the parcel under that " +
    "point AND its full record; given a reference or an address it returns the " +
    "parcel's coordinates plus ready map links. Use it whenever the person asks " +
    "where a parcel is, what is at a point, or wants an address, a reference and " +
    "a map position matched to each other.",
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
        description: "Full or partial cadastral reference, if the person already has one (from a listing or informe urbanistico). Use this OR the street fields OR lat/lon, not several at once."
      },
      lat: {
        type: "number",
        description: "Latitude in WGS84 (EPSG:4326), e.g. 39.9163. Use together with lon to find which parcel sits under a point on the map."
      },
      lon: {
        type: "number",
        description: "Longitude in WGS84 (EPSG:4326), e.g. 4.2649 — negative west of Greenwich. Use together with lat."
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

  // A pair of decimal degrees is a parcel question even with no keyword at
  // all: "39.8517, 4.2617" means "what is here".
  if (/-?\d{1,2}\.\d{3,}\s*[,;]\s*-?\d{1,3}\.\d{3,}/.test(t)) return true;

  // Latin (es/ca/en) AND Cyrillic. The Cyrillic half was missing, so every
  // cadastre question asked in Russian silently ran without the tool and the
  // answer came from the model's guesswork instead of the register.
  return /catastr|referencia\s+catastral|idealista\.[a-z]+\/inmueble|\bparcela\b|\bsolar\b|\bfinca\b|edificabilidad|urban[ií]stic|cadastral|cadastre/i.test(t)
      || /кадастр|участ[ое]к|парцел|надел|застро[ий]|урбанист|землевладен|межеван/i.test(t);
}

// ---------- idealista listings ----------
//
// A listing link pasted into the chat used to end in "I can't open that, send
// me a screenshot" — the single most embarrassing thing an estate agent can
// say. The portal publishes an MCP endpoint (the one behind their own ChatGPT
// app) that needs no key and returns the whole record: price, built and usable
// area, plot, rooms, energy certificate, every photo and floor plan, the
// agency and its phone. Anthropic's API can call that endpoint itself, so the
// Worker only has to name it — see the mcp_servers block in handleChatPost.

// Tried in order when the address is not yet in settings. Each is a POST that
// costs nothing when it fails, and the winner is written to the settings table
// so the probe runs once, not once per message.
const IDEALISTA_MCP_CANDIDATES = [
  "https://mcp.idealista.com/mcp",
  "https://mcp.idealista.com/",
  "https://www.idealista.com/mcp",
  "https://api.idealista.com/mcp"
];

const IDEALISTA_PROBE_EVERY = 86400;   // a failed sweep is not repeated for a day

// An idealista URL, a bare listing code next to the portal's name, or a plain
// request to look at "the listing". Deliberately narrow: this only decides
// whether to hand Anthropic one extra server to call.
function looksLikeListingQuery(text) {
  if (!text) return false;
  return /idealista\.(com|it|pt)/i.test(text)
      || /\b(inmueble|immobile|imovel|im[oó]vel)\/\d{6,}/i.test(text);
}

// MCP's initialize handshake, nothing more. A server that answers this is the
// right address; anything else (404, HTML, a timeout) is not.
async function idealistaProbe(url) {
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "agentalla", version: "1" }
    }
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body
  });
  if (!res.ok) return false;
  const text = (await res.text()).slice(0, 4000);
  return text.indexOf("protocolVersion") !== -1 || text.indexOf("serverInfo") !== -1;
}

// Finds the endpoint once and remembers it. Returns "" when nothing answered,
// which simply means Alla answers about listings the way she does today.
async function discoverIdealista(env, cfg) {
  if (cfg.idealistaMcpUrl) return cfg.idealistaMcpUrl;
  if (!hasDB(env)) return "";
  if (nowSec() - (cfg.idealistaProbedAt || 0) < IDEALISTA_PROBE_EVERY) return "";

  let found = "";
  for (const url of IDEALISTA_MCP_CANDIDATES) {
    try { if (await idealistaProbe(url)) { found = url; break; } } catch (e) { /* next */ }
  }
  try {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('idealista_probed_at', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(String(nowSec())).run();
    if (found) {
      await env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES ('idealista_mcp_url', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(found).run();
    }
  } catch (e) { /* discovery must never break a message */ }
  return found;
}

// One request to a coordinates service. Tries the JSON endpoint and falls
// back to the XML one, because the .svc/json path is not documented as
// reliably as the .asmx path and a 404 here would otherwise cost a deploy.
async function catastroCoord(op, params) {
  const qs = new URLSearchParams(params).toString();
  try {
    const res = await fetch(CATASTRO_COORD_JSON + op + "?" + qs, { headers: { accept: "application/json" } });
    const raw = await res.text();
    try { return { format: "json", status: res.status, data: JSON.parse(raw) }; }
    catch (e) { /* not JSON — fall through to XML */ }
  } catch (e) { /* network — fall through */ }
  try {
    const res = await fetch(CATASTRO_COORD_XML + op + "?" + qs);
    const raw = await res.text();
    return { format: "xml", status: res.status, data: raw.slice(0, 4000) };
  } catch (e) {
    return { error: "fetch_failed", message: String((e && e.message) || e) };
  }
}

// Pulls lon/lat out of either shape. The services answer with xcen/ycen.
function pickCoords(payload) {
  if (!payload) return null;
  if (payload.format === "json") {
    const j = JSON.stringify(payload.data);
    const m = j.match(/"xcen"\s*:\s*"?(-?[\d.]+)"?[\s\S]{0,80}?"ycen"\s*:\s*"?(-?[\d.]+)"?/i);
    if (m) return { lon: Number(m[1]), lat: Number(m[2]) };
  }
  const t = typeof payload.data === "string" ? payload.data : JSON.stringify(payload.data || "");
  const m2 = t.match(/xcen[>"']*\s*[:>]?\s*"?(-?[\d.]+)/i);
  const m3 = t.match(/ycen[>"']*\s*[:>]?\s*"?(-?[\d.]+)/i);
  if (m2 && m3) return { lon: Number(m2[1]), lat: Number(m3[1]) };
  return null;
}

// Pulls the first cadastral reference out of a coordinates answer.
function pickRef(payload) {
  const t = typeof payload.data === "string" ? payload.data : JSON.stringify(payload.data || "");
  const pc = t.match(/"pc1"\s*:\s*"([^"]+)"[\s\S]{0,60}?"pc2"\s*:\s*"([^"]+)"/i)
          || t.match(/<pc1>([^<]+)<\/pc1>\s*<pc2>([^<]+)<\/pc2>/i);
  if (pc) return (pc[1] + pc[2]).trim();
  const rc = t.match(/"rc"\s*:\s*"([A-Z0-9]{14,20})"/i) || t.match(/<rc>([A-Z0-9]{14,20})<\/rc>/i);
  return rc ? rc[1].trim() : null;
}

// A point anyone can click, with no Google key and no per-call cost. The
// satellite link is the one that actually helps on a plot with no street view.
function mapLinks(lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number" || !isFinite(lat) || !isFinite(lon)) return null;
  const q = lat.toFixed(7) + "," + lon.toFixed(7);
  return {
    coordinates: { lat: Number(lat.toFixed(7)), lon: Number(lon.toFixed(7)) },
    google_maps: "https://www.google.com/maps?q=" + q,
    google_satellite: "https://www.google.com/maps/@" + q + ",300m/data=!3m1!1e3",
    catastro_viewer: "https://www1.sedecatastro.gob.es/Cartografia/mapa.aspx?refcat="
  };
}

async function runCatastroTool(input) {
  input = input || {};
  const provincia = String(input.provincia || "").trim();
  const municipio = String(input.municipio || "").trim();
  let op, params;

  // A point on the map -> the parcel under it. This is the direction that was
  // missing: an agent standing on a plot, or a pin dropped on Google Maps,
  // now resolves to a cadastral reference and from there to the full record.
  const lat = Number(input.lat), lon = Number(input.lon);
  if (isFinite(lat) && isFinite(lon) && !input.referencia_catastral) {
    const hit = await catastroCoord("Consulta_RCCOOR", {
      SRS: "EPSG:4326", Coordenada_X: String(lon), Coordenada_Y: String(lat)
    });
    const ref = pickRef(hit);
    const out = {
      source: "Sede Electronica del Catastro (free public service; not a legally certified extract)",
      operation: "Consulta_RCCOOR",
      asked_point: { lat: lat, lon: lon },
      referencia_catastral: ref,
      result: hit,
      map: mapLinks(lat, lon)
    };
    // With a reference in hand, fetch the full record too, so one question
    // gives the agent everything instead of two round trips.
    if (ref && provincia && municipio) {
      out.full_record = await catastroByRef(provincia, municipio, ref);
    }
    return out;
  }

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
  let out;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const raw = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = { unparsed_response: raw.slice(0, 4000) };
    }
    out = {
      source: "Sede Electronica del Catastro (free public service; not a legally certified extract)",
      operation: op,
      http_status: res.status,
      result: parsed
    };
  } catch (e) {
    return { error: "fetch_failed", message: String((e && e.message) || e) };
  }

  // Whichever way the parcel was found, finish by placing it on a map: the
  // reference alone tells an agent nothing about where the plot actually is.
  const ref = input.referencia_catastral
    ? String(input.referencia_catastral).trim()
    : pickRef({ data: out.result });
  if (ref && provincia && municipio) {
    const pt = await catastroCoord("Consulta_CPMRC", {
      Provincia: provincia, Municipio: municipio, SRS: "EPSG:4326", RC: ref
    });
    const c = pickCoords(pt);
    if (c) {
      out.map = mapLinks(c.lat, c.lon);
      out.map.catastro_viewer += encodeURIComponent(ref);
    } else {
      out.map_lookup = pt;   // so a failure is visible rather than silently absent
    }
    out.referencia_catastral = ref;
  }
  return out;
}

// The full record for a reference — used after a point resolves to one.
async function catastroByRef(provincia, municipio, ref) {
  const url = CATASTRO_BASE + "Consulta_DNPRC?" + new URLSearchParams({
    Provincia: provincia, Municipio: municipio, RC: ref
  }).toString();
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const raw = await res.text();
    try { return JSON.parse(raw); } catch (e) { return { unparsed_response: raw.slice(0, 4000) }; }
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

// ---------- attachments ----------
//
// Anthropic reads PDFs and images natively, so there is no parser here — the
// bytes are passed through as content blocks. Limits are deliberately well
// under the API's own 32MB/100-page ceiling: a PDF costs 1,500-3,000 input
// tokens PER PAGE, so an unbounded upload is an unbounded bill.
const ATTACH_KIND = {
  "application/pdf": "document",
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image"
};
const MAX_ATTACHMENTS = 5;
const MAX_ATTACH_BYTES = 8 * 1024 * 1024;   // per file
const MAX_ATTACH_TOTAL = 20 * 1024 * 1024;  // per message

// Attaches the files to the NEWEST user turn, turning its content from a
// string into a block array. Older turns keep their text only: re-sending a
// document on every follow-up would multiply the cost of one reading by the
// length of the conversation, and the model's own previous answer already
// carries what it found.
function attachFiles(cleaned, raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (raw.length > MAX_ATTACHMENTS) return jsonError(400, "too_many_files");

  const blocks = [];
  let total = 0;
  for (const a of raw) {
    if (!a || typeof a.type !== "string" || typeof a.data !== "string") {
      return jsonError(400, "invalid_attachment");
    }
    const kind = ATTACH_KIND[a.type];
    if (!kind) return jsonError(415, "file_type_unsupported");
    const bytes = Math.floor(a.data.length * 3 / 4);  // base64 -> bytes
    if (bytes > MAX_ATTACH_BYTES) return jsonError(413, "file_too_large");
    total += bytes;
    if (total > MAX_ATTACH_TOTAL) return jsonError(413, "files_too_large");
    blocks.push({ type: kind, source: { type: "base64", media_type: a.type, data: a.data } });
  }

  for (let i = cleaned.length - 1; i >= 0; i--) {
    if (cleaned[i].role === "user") {
      cleaned[i].content = blocks.concat([{ type: "text", text: cleaned[i].content }]);
      return null;
    }
  }
  return jsonError(400, "invalid_history");
}

async function handleChatPost(request, env, cfg) {
  cfg = cfg || {};
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
  const lastText = lastUserMessage && lastUserMessage.content;
  const useCadastreTool = looksLikeCadastreQuery(lastText);
  // A report has to be written, stored and linked, all of which this Worker
  // does itself — so a turn that asks for one takes the tool path, exactly as
  // a cadastral question does.
  const useReportTool = looksLikeReportRequest(lastText);
  const useTools = useCadastreTool || useReportTool;

  // Only a turn that actually mentions a listing gets the extra server. It is
  // attached to whichever path the turn was already taking, and askAnthropic()
  // drops it and retries once if the API will not take it — a listing link
  // must never be the reason an ordinary answer fails.
  const listingUrl = looksLikeListingQuery(lastUserMessage && lastUserMessage.content)
    ? await discoverIdealista(env, cfg)
    : "";
  const mcpServers = listingUrl
    ? [{ type: "url", url: listingUrl, name: "idealista" }]
    : null;

  async function askAnthropic(payload) {
    const headers = {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    };
    if (mcpServers) {
      headers["anthropic-beta"] = "mcp-client-2025-04-04";
      payload = Object.assign({}, payload, { mcp_servers: mcpServers });
    }
    let res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers, body: JSON.stringify(payload)
    });
    if (!res.ok && mcpServers && res.status >= 400 && res.status < 500) {
      // The endpoint was refused (wrong address, beta withdrawn, server down).
      // Ask again without it rather than failing the person's message.
      const bare = Object.assign({}, payload);
      delete bare.mcp_servers;
      const plain = {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      };
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: plain, body: JSON.stringify(bare)
      });
    }
    return res;
  }

  // After the cadastre check, which needs plain text: this turns the newest
  // user message's content into blocks.
  const attachError = attachFiles(cleaned, body && body.attachments);
  if (attachError) return attachError;

  if (!useTools) {
    // Original fast path: single streamed call, no tools. Unchanged from
    // before this session's cadastre-lookup work so the common case (general
    // advice, no specific parcel/address) keeps its original low latency.
    let anthropicRes;
    try {
      anthropicRes = await askAnthropic({
          model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          stream: true,
          // Web search only. It is executed by Anthropic inside this same
          // streamed response, so the fast path stays a single call with no
          // round trip of our own — which is why catastro_lookup, which this
          // Worker has to execute itself, is NOT offered here (a tool_use for
          // it would end the stream with nobody to answer it). Cadastral
          // questions take the tool path below instead.
          tools: [WEB_SEARCH_TOOL],
          messages: cleaned
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
  // The tool path makes several Anthropic calls for one visible answer. Their
  // token counts are summed here so metering bills the whole exchange rather
  // than only the final round.
  const usageTotal = { input_tokens: 0, output_tokens: 0 };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let res;
    try {
      res = await askAnthropic({
          model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          // Both, deliberately: the cadastre says what the property legally
          // is, the search says what the rules and the prices around it are.
          // Web search runs server-side, so the loop below only ever has to
          // execute catastro_lookup itself.
          // catastro_lookup and property_report are both executed below by
          // this Worker; web search runs inside Anthropic's own turn.
          tools: [CATASTRO_TOOL, REPORT_TOOL, WEB_SEARCH_TOOL],
          messages
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

    if (data.usage) {
      usageTotal.input_tokens += data.usage.input_tokens || 0;
      usageTotal.output_tokens += data.usage.output_tokens || 0;
      const su = data.usage.server_tool_use;
      if (su && su.web_search_requests) {
        usageTotal.server_tool_use = usageTotal.server_tool_use || { web_search_requests: 0 };
        usageTotal.server_tool_use.web_search_requests += su.web_search_requests;
      }
    }

    if (data.stop_reason !== "tool_use") {
      // Final answer — reconstruct it as a real-shaped SSE stream, carrying
      // the summed usage so the meter downstream sees the true cost.
      data.usage = { ...usageTotal };
      return new Response(syntheticSSEFromMessage(data), {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
      });
    }

    // (usage for this round is already added to usageTotal above)
    // Execute every tool_use block in this turn, then loop so Claude can
    // answer using the results (or ask for one more lookup, up to the cap).
    // Only client-side tool_use blocks, and only the one tool this Worker
    // knows how to run. Web search arrives as server_tool_use and is already
    // executed by Anthropic, so it must never reach runCatastroTool.
    const toolUseBlocks = (data.content || [])
      .filter((b) => b.type === "tool_use" &&
                     (b.name === "catastro_lookup" || b.name === "property_report"));
    messages.push({ role: "assistant", content: data.content });

    const toolResults = [];
    for (const block of toolUseBlocks) {
      const result = block.name === "property_report"
        ? await runReportTool(block.input, env, request)
        : await runCatastroTool(block.input);
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


// ===================================================================
// ACCOUNTS, ENTITLEMENT AND BILLING  (Cloudflare D1 + Stripe)
// ===================================================================
// Everything lives in this Worker and one D1 database (binding: DB), per
// the architecture Evgeny picked: one place, one deploy.
//
// Three ideas hold it together:
//
//   1. The usage ledger is the source of truth. Every answered message
//      writes one row with the real token counts and what they cost in
//      micro-euros. Allowances, invoices and disputes all read from it.
//   2. Nothing is charged that the customer did not opt into. Overage is
//      only ever billed when `autopay` is on; otherwise the account is told
//      it has reached its allowance and stops there.
//   3. `billing_enabled` is a kill switch. While it is '0' the whole system
//      still counts and records, but never blocks and never charges — so
//      the metering can be verified against real traffic before a single
//      euro moves.

const SESSION_COOKIE = "alla_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 30;
const PBKDF2_ITERATIONS = 210000;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function jsonOk(data, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8" }, extraHeaders || {})
  });
}

function hasDB(env) {
  return !!(env && env.DB && typeof env.DB.prepare === "function");
}

// ---------- settings (table-driven knobs, no redeploy to change) ----------

async function loadSettings(env) {
  const out = {};
  try {
    const rs = await env.DB.prepare("SELECT key, value FROM settings").all();
    for (const row of rs.results || []) out[row.key] = row.value;
  } catch (e) { /* table missing -> defaults below */ }
  const num = (k, d) => (out[k] !== undefined && out[k] !== "" ? Number(out[k]) : d);
  return {
    raw: out,
    usdToEur: num("usd_to_eur", 0.92),
    // Web search is billed per search on top of tokens, so it has to be
    // metered separately or an allowance quietly under-counts.
    searchUsd: num("web_search_usd_per_search", 0.01),
    trialDays: num("trial_days", 14),
    trialMessages: num("trial_messages", 25),
    anonPerDay: num("anon_messages_per_day", 5),
    allowanceEur: { standard: num("allowance_standard_eur", 10), pro: num("allowance_pro_eur", 25) },
    priceId: { standard: out.price_id_standard || "", pro: out.price_id_pro || "" },
    // Speech-to-text is billed per MINUTE OF AUDIO, not per token, so it needs
    // its own rate and its own column in the ledger. Everything here is a
    // settings row so the price can be corrected without a deploy.
    transcribeModel: out.transcribe_model || "gpt-transcribe",
    transcribeUsdPerMin: num("transcribe_usd_per_min", 0.0045),
    transcribeMaxSeconds: num("transcribe_max_seconds", 120),
    transcribeMaxBytes: num("transcribe_max_bytes", 8000000),
    transcribeMaxPerHour: num("transcribe_max_per_hour", 40),
    // The portal's own MCP endpoint — the same one behind their ChatGPT app,
    // and authless. A settings row rather than a constant because the address
    // is not published anywhere: the moment it is known it can be set here
    // and listings start working, with no deploy. Empty means "not known yet",
    // and then discoverIdealista() goes looking once a day.
    idealistaMcpUrl: out.idealista_mcp_url || "",
    idealistaProbedAt: num("idealista_probed_at", 0),
    billingEnabled: out.billing_enabled === "1"
  };
}

// ---------- crypto ----------

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64url(a);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// PBKDF2 rather than bcrypt: Workers have no native modules, but WebCrypto
// is first-class here and PBKDF2-HMAC-SHA256 at 210k iterations is the
// OWASP-current setting for this primitive.
async function hashPassword(password, saltB64) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))
                       : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, key, 256);
  return { hash: b64url(new Uint8Array(bits)), salt: b64url(salt) };
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- sessions ----------

function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function sessionCookie(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function createSession(env, userId) {
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const t = nowSec();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(hash, userId, t, t + SESSION_TTL_SEC).run();
  return token;
}

async function currentUser(request, env) {
  if (!hasDB(env)) return null;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(hash, nowSec()).first();
  return row || null;
}

// ---------- pricing ----------

// Token counts -> micro-euros, using the DB price row and FX setting so a
// vendor price change is an UPDATE, not a deploy.
async function eurMicrosFor(env, cfg, model, inTok, outTok, searches, audioSeconds) {
  let price = null;
  try {
    price = await env.DB.prepare("SELECT * FROM model_prices WHERE model = ?").bind(model).first();
  } catch (e) { /* fall through */ }
  const inRate = price ? price.input_usd_per_mtok : 3.0;
  const outRate = price ? price.output_usd_per_mtok : 15.0;
  const usd = (inTok / 1e6) * inRate
            + (outTok / 1e6) * outRate
            + (searches || 0) * (cfg.searchUsd || 0)
            + ((audioSeconds || 0) / 60) * (cfg.transcribeUsdPerMin || 0);
  return Math.round(usd * cfg.usdToEur * 1e6);
}

async function usageSince(env, userId, sinceTs) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(eur_micros), 0) AS spent FROM usage_ledger WHERE user_id = ? AND at >= ?"
  ).bind(userId, sinceTs).first();
  return row ? Number(row.spent) : 0;
}

// ---------- entitlement ----------
//
// Returns { actor } when the message may proceed, or a Response explaining
// why not. While billing_enabled is '0' it never refuses — it still resolves
// the actor so usage is recorded and the numbers can be trusted before the
// switch is thrown.

async function gateChat(request, env, cfg) {
  if (!hasDB(env)) return { actor: { kind: "nodb" } };

  const user = await currentUser(request, env);

  if (!user) {
    const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
    const day = new Date().toISOString().slice(0, 10);
    const anonKey = await sha256Hex(`${ip}|${day}`);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM usage_ledger WHERE anon_key = ?"
    ).bind(anonKey).first();
    const used = row ? Number(row.n) : 0;
    if (cfg.billingEnabled && used >= cfg.anonPerDay) {
      return {
        response: new Response(JSON.stringify({
          error: "sign_in_required",
          used, limit: cfg.anonPerDay
        }), { status: 401, headers: { "content-type": "application/json" } })
      };
    }
    return { actor: { kind: "anon", anonKey } };
  }

  const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ?").bind(user.id).first();

  if (sub && (sub.status === "active" || sub.status === "trialing")) {
    const allowance = Math.round((cfg.allowanceEur[sub.plan] || 0) * 1e6);
    const since = sub.current_period_start || (nowSec() - 30 * 86400);
    const spent = await usageSince(env, user.id, since);
    if (cfg.billingEnabled && spent >= allowance && !sub.autopay) {
      return {
        response: new Response(JSON.stringify({
          error: "allowance_exceeded", plan: sub.plan,
          spent_eur: +(spent / 1e6).toFixed(2), allowance_eur: +(allowance / 1e6).toFixed(2)
        }), { status: 402, headers: { "content-type": "application/json" } })
      };
    }
    return { actor: { kind: "subscriber", user, sub } };
  }

  // No live subscription -> the free trial: N days or N messages, whichever
  // comes first. The clock starts at the first message, not at signup, so an
  // account created and left alone does not silently burn its trial.
  const started = user.trial_started_at || nowSec();
  const expired = nowSec() > started + cfg.trialDays * 86400;
  const usedUp = Number(user.trial_messages || 0) >= cfg.trialMessages;
  if (cfg.billingEnabled && (expired || usedUp)) {
    return {
      response: new Response(JSON.stringify({
        error: "trial_over",
        reason: expired ? "days" : "messages",
        messages_used: Number(user.trial_messages || 0),
        messages_limit: cfg.trialMessages
      }), { status: 402, headers: { "content-type": "application/json" } })
    };
  }
  return { actor: { kind: "trial", user, trialStarted: started } };
}

// One row per answered message, plus the trial counter. Called after the
// answer has been delivered, via ctx.waitUntil, so metering never delays or
// breaks a reply.
async function recordUsage(env, cfg, actor, model, inTok, outTok, searches) {
  if (!hasDB(env) || !actor || actor.kind === "nodb") return;
  const eur = await eurMicrosFor(env, cfg, model, inTok, outTok, searches);
  const t = nowSec();
  const userId = actor.user ? actor.user.id : null;
  const anonKey = actor.anonKey || null;
  const stmts = [
    env.DB.prepare(
      `INSERT INTO usage_ledger (user_id, anon_key, at, model, input_tokens, output_tokens, search_requests, eur_micros)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(userId, anonKey, t, model, inTok, outTok, searches || 0, eur)
  ];
  if (actor.kind === "trial") {
    stmts.push(env.DB.prepare(
      `UPDATE users SET trial_messages = trial_messages + 1,
                        trial_started_at = COALESCE(trial_started_at, ?)
        WHERE id = ?`
    ).bind(actor.trialStarted, actor.user.id));
  }
  try { await env.DB.batch(stmts); } catch (e) { /* metering must never break a reply */ }
}

// ---------- speech to text ----------
//
// The browser records audio and posts the bytes here; the key never leaves
// the worker. Language is deliberately NOT sent: the model detects it, which
// is the whole point of moving off the browser's own recogniser.

// Only what OpenAI's transcription endpoint actually accepts. The value is the
// filename extension, because that is what the API uses to sniff the format —
// the MIME type on the part is not enough on its own.
const AUDIO_EXT = {
  "audio/webm": "webm",      // Chrome, Edge, Android
  "audio/mp4": "mp4",        // Safari (macOS and iOS)
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "m4a",
  "audio/mpeg": "mp3",
  "audio/mpga": "mpga",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg"         // Firefox
};

// One ledger row per transcription. Deliberately NOT recordUsage(): that one
// also burns a trial message, and dictating a sentence is not a message.
async function recordAudioUsage(env, cfg, actor, model, seconds) {
  if (!hasDB(env) || !actor || actor.kind === "nodb") return;
  const eur = await eurMicrosFor(env, cfg, model, 0, 0, 0, seconds);
  try {
    await env.DB.prepare(
      `INSERT INTO usage_ledger (user_id, anon_key, at, model, input_tokens, output_tokens, search_requests, audio_seconds, eur_micros)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)`
    ).bind(actor.user ? actor.user.id : null, actor.anonKey || null, nowSec(), model, Math.round(seconds), eur).run();
  } catch (e) { /* metering must never break dictation */ }
}

async function audioUsesLastHour(env, actor) {
  if (!hasDB(env) || !actor) return 0;
  const since = nowSec() - 3600;
  const sql = actor.user
    ? "SELECT COUNT(*) AS n FROM usage_ledger WHERE user_id = ? AND audio_seconds > 0 AND at >= ?"
    : "SELECT COUNT(*) AS n FROM usage_ledger WHERE anon_key = ? AND audio_seconds > 0 AND at >= ?";
  try {
    const row = await env.DB.prepare(sql).bind(actor.user ? actor.user.id : (actor.anonKey || ""), since).first();
    return row ? Number(row.n) : 0;
  } catch (e) { return 0; }
}

// Asks OpenAI one harmless question — "does this model exist for me?" — and
// reports what came back. It costs nothing, transcribes nothing, and returns
// only a status and the short error code, never the key or the error body.
async function transcribeHealth(env) {
  const key = env.OPENAI_API_KEY;
  const out = { configured: !!key, model: "gpt-transcribe" };
  if (!key) return jsonOk(out);
  try {
    const res = await fetch("https://api.openai.com/v1/models/" + out.model, {
      headers: { authorization: "Bearer " + key }
    });
    out.upstream = res.status;
    out.ok = res.ok;
    if (!res.ok) {
      try {
        const err = await res.json();
        const e = err && err.error;
        if (e) out.reason = String(e.code || e.type || "").slice(0, 40);
      } catch (e) { /* non-JSON upstream error */ }
    }
  } catch (e) {
    out.ok = false;
    out.reason = "unreachable";
  }
  return jsonOk(out);
}

async function handleTranscribe(request, env, cfg, ctx) {
  // The key is read here and nowhere else. It is never logged, never echoed,
  // and no upstream error body is passed back to the browser.
  const key = env.OPENAI_API_KEY;
  if (!key) return jsonError(503, "transcribe_not_configured");
  try {
    return await transcribe(request, env, cfg, ctx, key);
  } catch (e) {
    // An uncaught throw here would surface as Cloudflare's own 502 HTML page,
    // which tells nobody anything. Report the message instead — with the key
    // scrubbed, in the unlikely event it ever appears inside one.
    let detail = String((e && e.message) || e).slice(0, 200);
    if (key && detail.indexOf(key) !== -1) detail = detail.split(key).join("[redacted]");
    return new Response(JSON.stringify({ error: "transcribe_exception", detail }),
                        { status: 422, headers: { "content-type": "application/json" } });
  }
}

async function transcribe(request, env, cfg, ctx, key) {

  const rawType = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = AUDIO_EXT[rawType];
  if (!ext) return jsonError(415, "audio_type_unsupported");

  const maxBytes = cfg.transcribeMaxBytes || 8000000;
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared && declared > maxBytes) return jsonError(413, "audio_too_large");

  // Who is speaking — same resolution as chat, so the row lands on the right
  // account. gateChat only reads; it has no side effects of its own.
  const gate = await gateChat(request, env, cfg);
  if (gate.response) return gate.response;
  const actor = gate.actor;

  const perHour = cfg.transcribeMaxPerHour || 40;
  if (await audioUsesLastHour(env, actor) >= perHour) return jsonError(429, "transcribe_rate_limited");

  const buf = await request.arrayBuffer();
  if (!buf || buf.byteLength < 1024) return jsonError(400, "audio_empty");
  if (buf.byteLength > maxBytes) return jsonError(413, "audio_too_large");

  // The client reports how long it recorded. It is used only for metering and
  // is clamped both ways, so a wrong or hostile value cannot distort billing.
  const maxSec = cfg.transcribeMaxSeconds || 120;
  let seconds = Number(request.headers.get("x-audio-seconds") || 0);
  if (!isFinite(seconds) || seconds <= 0) seconds = 1;
  if (seconds > maxSec) return jsonError(413, "audio_too_long");

  const model = cfg.transcribeModel || "gpt-transcribe";
  let upstream;
  try {
    const fd = new FormData();
    fd.append("file", new File([buf], "audio." + ext, { type: rawType }));
    fd.append("model", model);
    // No `language` on purpose — the model detects it.
    upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer " + key },
      body: fd
    });
  } catch (e) {
    return jsonError(422, "transcribe_failed");
  }

  if (!upstream.ok) {
    // The upstream BODY is never passed through — it is not useful to the
    // person and must never become a channel for anything about the key. But
    // the short machine-readable reason is: without it an upstream problem
    // (no credit on the account, say) is indistinguishable from our own rate
    // limit, which sent one earlier debugging session down the wrong path.
    let reason = "";
    try {
      const err = await upstream.json();
      const code = err && err.error && (err.error.code || err.error.type);
      if (typeof code === "string") reason = code.slice(0, 40);
    } catch (e) { /* non-JSON upstream error */ }
    // 422, not 502: Cloudflare replaces 502/503/504 from a Worker with its own
    // branded error page, which swallows this body entirely.
    return new Response(JSON.stringify({
      error: "transcribe_failed", upstream: upstream.status, reason
    }), { status: 422, headers: { "content-type": "application/json" } });
  }

  let text = "";
  try {
    const data = await upstream.json();
    if (data && typeof data.text === "string") text = data.text.trim();
  } catch (e) { /* empty text is handled by the client */ }

  const meter = recordAudioUsage(env, cfg, actor, model, seconds);
  if (ctx && ctx.waitUntil) ctx.waitUntil(meter); else await meter;

  return jsonOk({ text });
}

// ================= PDF generation =================
// Everything from here to the end of the report section is the document
// writer. It is inlined rather than imported because a Pages _worker.js is
// one file; the source of record is pdfkit.js / memo.js in the deploy tree,
// and mkfont.py builds the font tables it reads.

// A PDF writer with no dependencies, small enough to live inside the Worker.
//
// Why hand-written: Cloudflare's HTML-to-PDF rendering needs the paid Workers
// plan, and every JS PDF library assumes Node. What a memorandum actually
// needs is narrow — text, rules, filled rectangles, tables — and PDF is a
// plain text format, so the whole thing fits in a few hundred lines.
//
// The one genuinely hard part is fonts. The standard PDF fonts cannot render
// Cyrillic at all, and half of Alla's readers write Russian. So the document
// embeds a subset of Liberation Sans and addresses it through Identity-H,
// where a string is a run of 2-byte glyph ids rather than characters. The
// unicode-to-glyph and glyph-to-width tables are built offline (mkfont.py);
// nothing here parses TrueType.

const PT = 1;                    // PDF's unit is the point
const A4 = { w: 595.28, h: 841.89 };

// ---------- low-level object writer ----------

class Out {
  constructor() { this.parts = []; this.len = 0; }
  raw(bytes) { this.parts.push(bytes); this.len += bytes.length; return this; }
  str(s) {
    // PDF syntax outside strings is ASCII; text is written as hex, so a
    // byte-per-char encoding is correct here and avoids a TextEncoder pass.
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return this.raw(b);
  }
  bytes() {
    const all = new Uint8Array(this.len);
    let at = 0;
    for (const p of this.parts) { all.set(p, at); at += p.length; }
    return all;
  }
}

// A PDF string. Plain ASCII goes in parentheses with the two special
// characters escaped; anything else becomes a UTF-16BE hex string, because a
// literal string is bytes and a Cyrillic title written as bytes comes out of
// a reader's Properties panel as mojibake.
function pdfString(s) {
  const str = String(s);
  if (/^[\x20-\x7e]*$/.test(str)) {
    return "(" + str.replace(/([\\()])/g, "\\$1") + ")";
  }
  let hex = "feff";
  for (let i = 0; i < str.length; i++) {
    hex += str.charCodeAt(i).toString(16).padStart(4, "0");
  }
  return "<" + hex + ">";
}

// ---------- fonts ----------

// One embedded face. `map` is unicode -> glyph id, `widths` glyph id -> 1/1000
// em, both from mkfont.py; `data` is the subset TTF.
class Face {
  constructor(name, table, data) {
    this.name = name;
    this.data = data;
    this.metrics = table.metrics;
    // Built once per isolate, not once per report. Turning the JSON into two
    // Maps was most of the cost of generating a document, and the free plan
    // allows ten milliseconds of CPU for the whole request.
    if (!table._map) {
      table._map = new Map();
      for (const k in table.map) table._map.set(Number(k), table.map[k]);
      table._widths = new Map();
      for (const k in table.widths) table._widths.set(Number(k), table.widths[k]);
    }
    this.map = table._map;
    this.widths = table._widths;
    this.used = new Set();
  }

  // Unsupported characters become a space rather than a blank box: a report
  // with one odd character in it should still be a readable report.
  gid(cp) {
    const g = this.map.get(cp);
    if (g !== undefined) return g;
    return this.map.get(32) || 0;
  }

  width(text, size) {
    let w = 0;
    for (const ch of String(text)) {
      w += (this.widths.get(this.gid(ch.codePointAt(0))) || 0);
    }
    return w * size / 1000;
  }

  // The hex string a Tj operator takes, and a note of which glyphs the
  // document actually used (so /W and /ToUnicode stay small).
  encode(text) {
    let hex = "";
    for (const ch of String(text)) {
      const g = this.gid(ch.codePointAt(0));
      this.used.add(g);
      hex += g.toString(16).padStart(4, "0");
    }
    return "<" + hex + ">";
  }
}

// ---------- the page model ----------
//
// Content is accumulated per page as operator text. Nothing is measured
// twice: the layout code below asks the Face for widths before it writes.

class Page {
  constructor(doc) {
    this.doc = doc;
    this.ops = [];
  }
  op(s) { this.ops.push(s); }

  rect(x, y, w, h, color) {
    this.op(`${rgb(color)} rg ${n(x)} ${n(y)} ${n(w)} ${n(h)} re f`);
  }
  line(x1, y1, x2, y2, color, width) {
    this.op(`${rgb(color)} RG ${n(width || 0.6)} w ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S`);
  }
  text(str, x, y, face, size, color) {
    const key = this.doc.fontKey(face);
    this.op(`BT ${rgb(color)} rg /${key} ${n(size)} Tf 1 0 0 1 ${n(x)} ${n(y)} Tm ${face.encode(str)} Tj ET`);
  }
}

function n(v) { return (Math.round(v * 100) / 100).toString(); }
function rgb(c) {
  const [r, g, b] = c || [0, 0, 0];
  return `${n(r)} ${n(g)} ${n(b)}`;
}

// ---------- the document ----------

class Doc {
  constructor(opts) {
    opts = opts || {};
    this.size = opts.size || A4;
    this.margin = opts.margin || { top: 64, right: 56, bottom: 64, left: 56 };
    this.faces = opts.faces;            // { regular: Face, bold: Face }
    this.pages = [];
    this.page = null;
    this.y = 0;
    this.meta = opts.meta || {};
    this.onPage = opts.onPage || null;  // header/footer painter
    this.newPage();
  }

  get left() { return this.margin.left; }
  get right() { return this.size.w - this.margin.right; }
  get width() { return this.right - this.left; }

  fontKey(face) { return face === this.faces.bold ? "F2" : "F1"; }

  newPage() {
    this.page = new Page(this);
    this.pages.push(this.page);
    this.y = this.size.h - this.margin.top;
    if (this.onPage) this.onPage(this, this.pages.length);
    return this.page;
  }

  // Everything that draws calls this first, so a block never straddles the
  // bottom margin by accident.
  need(h) {
    if (this.y - h < this.margin.bottom) this.newPage();
  }

  gap(h) { this.y -= h; }

  // ---- text ----

  // Greedy wrap. Long unbreakable tokens (a URL, a cadastral reference) are
  // split rather than allowed to run into the margin.
  wrap(text, face, size, maxWidth) {
    const lines = [];
    for (const para of String(text).split("\n")) {
      if (!para) { lines.push(""); continue; }
      let line = "";
      for (const word of para.split(/\s+/)) {
        const probe = line ? line + " " + word : word;
        if (face.width(probe, size) <= maxWidth) { line = probe; continue; }
        if (line) { lines.push(line); line = ""; }
        if (face.width(word, size) <= maxWidth) { line = word; continue; }
        let chunk = "";
        for (const ch of word) {
          if (face.width(chunk + ch, size) > maxWidth) { lines.push(chunk); chunk = ""; }
          chunk += ch;
        }
        line = chunk;
      }
      if (line) lines.push(line);
    }
    return lines;
  }

  para(text, o) {
    o = o || {};
    const face = o.bold ? this.faces.bold : this.faces.regular;
    const size = o.size || 9.5;
    const lead = o.lead || size * 1.45;
    const color = o.color || [0.13, 0.13, 0.14];
    const x0 = o.x !== undefined ? o.x : this.left;
    const maxW = o.width || (this.right - x0);
    const lines = this.wrap(text, face, size, maxW);
    for (const line of lines) {
      this.need(lead);
      let x = x0;
      if (o.align === "right") x = x0 + maxW - face.width(line, size);
      else if (o.align === "center") x = x0 + (maxW - face.width(line, size)) / 2;
      this.page.text(line, x, this.y - size, face, size, color);
      this.y -= lead;
    }
    if (o.after) this.gap(o.after);
    return lines.length;
  }

  heading(text, o) {
    o = o || {};
    const size = o.size || 13;
    this.need(size * 2.2 + 10);
    this.gap(o.before === undefined ? 14 : o.before);
    this.para(text, { bold: true, size, color: o.color || [0.07, 0.09, 0.15], lead: size * 1.3 });
    if (o.rule !== false) {
      this.gap(3);
      this.page.line(this.left, this.y, this.right, this.y, [0.85, 0.86, 0.88], 0.7);
    }
    this.gap(o.after === undefined ? 9 : o.after);
  }

  bullets(items, o) {
    o = o || {};
    const size = o.size || 9.5;
    const indent = 12;
    for (const item of items) {
      this.need(size * 1.45);
      const yTop = this.y;
      this.page.text("•", this.left + 2, yTop - size, this.faces.regular, size, [0.45, 0.47, 0.5]);
      this.para(item, { x: this.left + indent, width: this.width - indent, size, after: 2 });
    }
    if (o.after) this.gap(o.after);
  }

  // ---- tables ----
  //
  // cols: [{ head, width, align }]; rows: arrays of strings. A row that does
  // not fit is moved whole to the next page, with the header repeated — a
  // key-metrics table split across a page break is how reports lose readers.
  table(cols, rows, o) {
    o = o || {};
    const size = o.size || 9;
    const padX = 7, padY = 6;
    const headBg = o.headBg || [0.95, 0.955, 0.97];
    const lineCol = [0.87, 0.88, 0.90];

    const total = cols.reduce((s, c) => s + c.width, 0);
    const scale = this.width / total;
    const w = cols.map((c) => c.width * scale);

    const cellLines = (row) => cols.map((c, i) =>
      this.wrap(row[i] === undefined || row[i] === null ? "" : String(row[i]),
                row.bold ? this.faces.bold : this.faces.regular, size, w[i] - padX * 2));

    const drawHead = () => {
      const h = size * 1.35 + padY * 2;
      this.need(h + 4);
      this.page.rect(this.left, this.y - h, this.width, h, headBg);
      let x = this.left;
      cols.forEach((c, i) => {
        const tx = c.align === "right" ? x + w[i] - padX - this.faces.bold.width(c.head, size) : x + padX;
        this.page.text(c.head, tx, this.y - padY - size, this.faces.bold, size, [0.20, 0.22, 0.26]);
        x += w[i];
      });
      this.y -= h;
      this.page.line(this.left, this.y, this.right, this.y, lineCol, 0.7);
    };

    drawHead();

    for (const row of rows) {
      const lines = cellLines(row);
      const rowH = Math.max(...lines.map((l) => l.length)) * size * 1.35 + padY * 2;
      if (this.y - rowH < this.margin.bottom) { this.newPage(); drawHead(); }
      if (row.shade) this.page.rect(this.left, this.y - rowH, this.width, rowH, row.shade);
      let x = this.left;
      const face = row.bold ? this.faces.bold : this.faces.regular;
      cols.forEach((c, i) => {
        let ty = this.y - padY - size;
        for (const line of lines[i]) {
          const tx = c.align === "right" ? x + w[i] - padX - face.width(line, size) : x + padX;
          this.page.text(line, tx, ty, face, size, row.color || [0.13, 0.13, 0.14]);
          ty -= size * 1.35;
        }
        x += w[i];
      });
      this.y -= rowH;
      this.page.line(this.left, this.y, this.right, this.y, lineCol, 0.5);
    }
    if (o.after) this.gap(o.after);
  }

  // ---- serialisation ----

  async build() {
    const objects = [];                       // 1-based; objects[i] is object i+1
    const add = (body) => { objects.push(body); return objects.length; };

    const pageIds = [];
    const contentIds = [];

    // Fonts first: the page resources have to name them.
    const fontIds = {};
    for (const key of ["F1", "F2"]) {
      const face = key === "F1" ? this.faces.regular : this.faces.bold;
      fontIds[key] = this.emitFont(add, face, key);
    }

    const pagesId = objects.length + this.pages.length * 2 + 1;

    for (const page of this.pages) {
      const stream = page.ops.join("\n");
      const cid = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      contentIds.push(cid);
      pageIds.push(add(
        `<< /Type /Page /Parent ${pagesId} 0 R ` +
        `/MediaBox [0 0 ${n(this.size.w)} ${n(this.size.h)}] ` +
        `/Resources << /Font << /F1 ${fontIds.F1} 0 R /F2 ${fontIds.F2} 0 R >> >> ` +
        `/Contents ${cid} 0 R >>`
      ));
    }

    const realPagesId = add(
      `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((i) => i + " 0 R").join(" ")}] >>`
    );
    // The page objects were written with a forward reference; it must land.
    if (realPagesId !== pagesId) {
      for (let i = 0; i < objects.length; i++) {
        if (typeof objects[i] !== "string") continue;
        objects[i] = objects[i].split(`/Parent ${pagesId} 0 R`).join(`/Parent ${realPagesId} 0 R`);
      }
    }

    const m = this.meta;
    const infoId = add(
      `<< /Title ${pdfString(m.title || "Report")} /Author ${pdfString(m.author || "")} ` +
      `/Subject ${pdfString(m.subject || "")} /Creator ${pdfString(m.creator || "Agent Alla")} ` +
      `/CreationDate ${pdfString(pdfDate(m.date || new Date()))} >>`
    );
    const catalogId = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);

    // ---- assemble ----
    const out = new Out();
    out.str("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(out.len);
      const body = objects[i];
      if (typeof body === "string") {
        out.str(`${i + 1} 0 obj\n${body}\nendobj\n`);
      } else {
        // A stream whose payload is binary (the embedded font). Written as
        // bytes so that nothing in the path can reinterpret it as text.
        out.str(`${i + 1} 0 obj\n${body.dict}\nstream\n`);
        out.raw(body.data);
        out.str("\nendstream\nendobj\n");
      }
    }
    const xref = out.len;
    out.str(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
    for (let i = 1; i <= objects.length; i++) {
      out.str(String(offsets[i]).padStart(10, "0") + " 00000 n \n");
    }
    out.str(
      `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n` +
      `startxref\n${xref}\n%%EOF\n`
    );
    return out.bytes();
  }

  // A Type0/Identity-H font with its subset embedded, plus a ToUnicode map so
  // the text can be selected, copied and searched — a report a bank cannot
  // search is half a report.
  emitFont(add, face, key) {
    const used = [...face.used].sort((a, b) => a - b);
    const widths = used.length
      ? "[" + used.map((g) => `${g} [${face.widths.get(g) || 0}]`).join(" ") + "]"
      : "[]";

    const ttf = face.data;
    const fileId = add({
      dict: `<< /Length ${ttf.length} /Length1 ${ttf.length} >>`,
      data: ttf,
    });

    const md = face.metrics;
    const descId = add(
      `<< /Type /FontDescriptor /FontName /${face.name} /Flags ${md.flags} ` +
      `/FontBBox [${md.bbox.join(" ")}] /ItalicAngle ${md.italicAngle} ` +
      `/Ascent ${md.ascent} /Descent ${md.descent} /CapHeight ${md.capHeight} ` +
      `/StemV ${md.stemV} /FontFile2 ${fileId} 0 R >>`
    );
    const cidId = add(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${face.name} ` +
      `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
      `/FontDescriptor ${descId} 0 R /DW 1000 /W ${widths} /CIDToGIDMap /Identity >>`
    );

    const toUni = toUnicodeCMap(face, used);
    const uniId = add(`<< /Length ${toUni.length} >>\nstream\n${toUni}\nendstream`);

    return add(
      `<< /Type /Font /Subtype /Type0 /BaseFont /${face.name} /Encoding /Identity-H ` +
      `/DescendantFonts [${cidId} 0 R] /ToUnicode ${uniId} 0 R >>`
    );
  }
}

function pdfDate(d) {
  const p = (v) => String(v).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
         `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function toUnicodeCMap(face, used) {
  const back = new Map();
  for (const [cp, gid] of face.map) if (!back.has(gid)) back.set(gid, cp);
  const rows = used.filter((g) => back.has(g))
    .map((g) => `<${g.toString(16).padStart(4, "0")}> <${back.get(g).toString(16).padStart(4, "0")}>`);
  const chunks = [];
  for (let i = 0; i < rows.length; i += 100) {
    const part = rows.slice(i, i + 100);
    chunks.push(`${part.length} beginbfchar\n${part.join("\n")}\nendbfchar`);
  }
  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
    "1 begincodespacerange <0000> <FFFF> endcodespacerange",
    ...chunks,
    "endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
}

// The ROILITY investment memorandum, as a layout.
//
// The structure is the one approved on the Son Remei report and recorded in
// layer-1-core-identity.md: cover, then Executive Summary with the key
// metrics table first, then the sections in a fixed order. Alla supplies the
// content as data; nothing here invents a number, and a section she has no
// material for is simply absent rather than padded.


const INK = [0.11, 0.12, 0.15];
const MUTED = [0.42, 0.45, 0.50];
const ACCENT = [0.10, 0.28, 0.45];
const RULE = [0.85, 0.86, 0.88];
const BAND = [0.96, 0.965, 0.975];

// Every section Alla can fill, in the order they must appear. `key` is what
// she puts in the tool call; `title` is the fallback heading.
const SECTIONS = [
  ["executive_summary", "Executive Summary"],
  ["asset_description", "Asset Description"],
  ["acquisition_cost", "Acquisition Cost"],
  ["construction_budget", "Construction Budget"],
  ["timeline", "Timeline"],
  ["market_comparables", "Market Comparables"],
  ["profitability", "Profitability Scenarios"],
  ["risks", "Risks and Open Items — Pending Due Diligence"],
];

function cover(doc, d) {
  const page = doc.page;
  const { w, h } = doc.size;

  page.rect(0, h - 210, w, 210, [0.07, 0.11, 0.18]);
  page.text(d.firm || "ROILITY S.L.", doc.left, h - 96, doc.faces.bold, 22, [1, 1, 1]);
  page.text(d.firmLine || "Real Estate Investment & Development — Balearic Islands",
            doc.left, h - 120, doc.faces.regular, 10, [0.72, 0.78, 0.86]);

  doc.y = h - 290;
  doc.para(d.title || "Investment Memorandum",
           { bold: true, size: 26, lead: 31, color: INK });
  if (d.property) {
    doc.gap(6);
    doc.para(d.property, { size: 13, lead: 18, color: MUTED });
  }

  doc.gap(26);
  page.line(doc.left, doc.y, doc.left + 90, doc.y, ACCENT, 2.2);
  doc.gap(26);

  // The facing table: the four or five numbers a reader wants before they
  // decide whether to read the rest.
  if (d.headline && d.headline.length) {
    doc.table(
      [{ head: d.headlineHead ? d.headlineHead[0] : "Key figure", width: 60 },
       { head: d.headlineHead ? d.headlineHead[1] : "Value", width: 40, align: "right" }],
      d.headline.map((r) => Object.assign([r[0], r[1]], { bold: r[2] === true })),
      { after: 22 }
    );
  }

  if (d.preparedFor) {
    doc.para(d.preparedFor, { size: 9.5, color: MUTED, after: 4 });
  }

  // Anchored to the bottom of the cover, not to the flow: the notice has a
  // fixed place on every report so a reader learns where to find it.
  const y = 118;
  page.line(doc.left, y + 40, doc.right, y + 40, RULE, 0.7);
  page.text(d.confidentialTitle || "CONFIDENTIAL", doc.left, y + 22, doc.faces.bold, 9, INK);
  const saveY = doc.y;
  doc.y = y + 12;
  doc.para(d.confidential ||
    "This document is confidential and prepared for the named recipient only. " +
    "It is not an offer, a valuation, or investment advice.",
    { size: 8, lead: 10.5, color: MUTED });
  doc.y = saveY;

  doc.newPage();
}

// A section is text, bullets, a table, or any combination — whatever Alla
// actually has for it.
function section(doc, heading, body) {
  if (!body) return;
  const has = body.text || (body.bullets && body.bullets.length) ||
              (body.table && body.table.rows && body.table.rows.length);
  if (!has) return;

  doc.heading(heading);
  if (body.text) doc.para(body.text, { after: body.bullets || body.table ? 8 : 4 });
  if (body.bullets && body.bullets.length) doc.bullets(body.bullets, { after: body.table ? 8 : 2 });
  if (body.table && body.table.rows && body.table.rows.length) {
    const cols = (body.table.cols || []).map((c, i) => ({
      head: typeof c === "string" ? c : c.head,
      width: typeof c === "string" ? (i === 0 ? 52 : 48 / Math.max(1, (body.table.cols.length - 1))) : (c.width || 25),
      align: typeof c === "string" ? (i === 0 ? "left" : "right") : (c.align || "right"),
    }));
    doc.table(cols, body.table.rows.map((r) => {
      const row = Array.isArray(r) ? r.slice() : (r.cells || []).slice();
      if (!Array.isArray(r) && r.total) { row.bold = true; row.shade = BAND; }
      return row;
    }), { after: 6 });
    if (body.table.note) {
      doc.para(body.table.note, { size: 8, color: MUTED, after: 4 });
    }
  }
}

async function renderMemorandum(faces, data) {
  const doc = new Doc({
    size: A4,
    faces,
    meta: {
      title: data.title || "Investment Memorandum",
      author: data.firm || "ROILITY S.L.",
      subject: data.property || "",
      creator: "Agent Alla",
      date: new Date(),
    },
    onPage(d, pageNo) {
      if (pageNo === 1) return;          // the cover carries no furniture
      const { w, h } = d.size;
      d.page.text(data.firm || "ROILITY S.L.", d.left, h - 40, d.faces.bold, 8, MUTED);
      if (data.property) {
        const t = data.property;
        d.page.text(t, d.right - d.faces.regular.width(t, 8), h - 40, d.faces.regular, 8, MUTED);
      }
      d.page.line(d.left, h - 50, d.right, h - 50, RULE, 0.6);
      const no = String(pageNo);
      d.page.text(no, w / 2 - d.faces.regular.width(no, 8) / 2, 40, d.faces.regular, 8, MUTED);
      if (data.footer) d.page.text(data.footer, d.left, 40, d.faces.regular, 7.5, MUTED);
    },
  });

  cover(doc, data);

  const sections = data.sections || {};
  for (const [key, fallback] of SECTIONS) {
    section(doc, (sections[key] && sections[key].heading) || fallback, sections[key]);
  }
  for (const extra of data.extraSections || []) {
    section(doc, extra.heading, extra);
  }

  doc.heading(data.legalHeading || "Legal Notice");
  doc.para(data.legal ||
    "Figures in this memorandum are drawn from the sources named beside them and " +
    "have not been independently verified. Asking prices are not transaction " +
    "prices. Nothing here is a valuation, a tax opinion, or investment advice, " +
    "and no decision should be taken on it without professional review.",
    { size: 8.5, lead: 11.5, color: MUTED });

  return doc.build();
}


// ---------- reports ----------
//
// Alla writes memoranda for real: she calls property_report with the content
// she has gathered, the Worker lays it out as a PDF, puts it in R2 and hands
// back a link. Nothing about the layout is hers to invent — the structure is
// the ROILITY house style, fixed — and nothing about the content is the
// Worker's: a section she has no material for simply does not appear.

const REPORT_TTL_DAYS = 90;

// The fonts are static assets of this same site. Fetched once per isolate;
// the parsed lookup tables are cached inside the Face objects.
let FONT_CACHE = null;

async function loadFaces(env, request) {
  if (FONT_CACHE) {
    return {
      regular: new Face("LiberationSans", FONT_CACHE.tables.regular, FONT_CACHE.regular),
      bold: new Face("LiberationSans-Bold", FONT_CACHE.tables.bold, FONT_CACHE.bold),
    };
  }
  const base = new URL(request.url);
  const get = async (path) => {
    const res = await env.ASSETS.fetch(new Request(new URL(path, base).toString()));
    if (!res.ok) throw new Error("font_missing:" + path);
    return res;
  };
  const [tablesRes, regRes, boldRes] = await Promise.all([
    get("/assets/pdf/fonts.json"),
    get("/assets/pdf/ls-regular.ttf"),
    get("/assets/pdf/ls-bold.ttf"),
  ]);
  FONT_CACHE = {
    tables: await tablesRes.json(),
    regular: new Uint8Array(await regRes.arrayBuffer()),
    bold: new Uint8Array(await boldRes.arrayBuffer()),
  };
  return loadFaces(env, request);
}

const REPORT_TOOL = {
  name: "property_report",
  description:
    "Produces a finished PDF memorandum in the ROILITY house style and returns a " +
    "link the person can open and forward. Use it when someone asks for a report, " +
    "memorandum, informe, dossier or 'send me this as a PDF' about a property or a " +
    "deal — not for an ordinary answer in the chat. Write EVERY heading, label and " +
    "sentence in the language the person is using. Put only figures you actually " +
    "have into it: each section is optional and an absent section is better than a " +
    "padded one, and where a number came from a listing or a register, say so in " +
    "the row's own source column. Keep it tight — the house style is a short " +
    "document whose key metrics are on the cover.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Document title, in the person's language." },
      property: { type: "string", description: "One line identifying the property: place, and the listing or cadastral reference if known." },
      prepared_for: { type: "string", description: "Who it is prepared for, and the date." },
      headline: {
        type: "array",
        description: "The three to six figures that belong on the cover. Each is [label, value] and optionally a third element true to emphasise the row.",
        items: { type: "array", items: { type: "string" } },
      },
      headline_head: {
        type: "array",
        description: "Column headings for the cover table, in the person's language, e.g. ['Показатель','Значение'].",
        items: { type: "string" },
      },
      sections: {
        type: "object",
        description: "Any of: executive_summary, asset_description, acquisition_cost, construction_budget, timeline, market_comparables, profitability, risks. Each may carry a heading (in the person's language), text, bullets and one table.",
        additionalProperties: {
          type: "object",
          properties: {
            heading: { type: "string" },
            text: { type: "string" },
            bullets: { type: "array", items: { type: "string" } },
            table: {
              type: "object",
              properties: {
                cols: { type: "array", items: { type: "string" } },
                rows: {
                  type: "array",
                  description: "Rows of cells. A totals row may be given as {\"cells\":[...],\"total\":true}.",
                  items: {},
                },
                note: { type: "string", description: "A caveat printed under the table." },
              },
            },
          },
        },
      },
      legal_heading: { type: "string" },
      legal: { type: "string", description: "The closing notice, in the person's language." },
      confidential: { type: "string", description: "The confidentiality line for the cover, in the person's language." },
    },
    required: ["title", "property"],
  },
};

function looksLikeReportRequest(text) {
  if (!text) return false;
  return /\b(memorand|report|dossier|informe|memoria|relat[óo]rio)\w*\b/i.test(text)
      || /\bpdf\b/i.test(text)
      || /меморандум|отч[её]т|справк[ауи]|документ\w*\s+(по|на)\b/i.test(text);
}

async function runReportTool(input, env, request) {
  if (!env.REPORTS || typeof env.REPORTS.put !== "function") {
    // Said plainly so Alla tells the person the truth rather than promising a
    // file that will never arrive.
    return { ok: false, error: "report_storage_unavailable",
             message: "Report storage is not configured, so no PDF can be produced right now." };
  }

  let faces;
  try {
    faces = await loadFaces(env, request);
  } catch (e) {
    return { ok: false, error: "fonts_unavailable", message: String(e.message || e) };
  }

  const data = {
    firm: "ROILITY S.L.",
    firmLine: "Real Estate Investment & Development — Balearic Islands",
    title: input.title,
    property: input.property,
    preparedFor: input.prepared_for,
    footer: "ROILITY S.L. · agentalla.com",
    headline: Array.isArray(input.headline) ? input.headline : [],
    headlineHead: Array.isArray(input.headline_head) ? input.headline_head : null,
    sections: input.sections || {},
    legalHeading: input.legal_heading,
    legal: input.legal,
    confidential: input.confidential,
  };

  let bytes;
  try {
    bytes = await renderMemorandum(faces, data);
  } catch (e) {
    return { ok: false, error: "render_failed", message: String(e.message || e) };
  }

  // A 128-bit name is the access control: the link is unguessable, and it is
  // the person's to forward or not. It also expires.
  const raw = crypto.getRandomValues(new Uint8Array(16));
  const id = [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expires = nowSec() + REPORT_TTL_DAYS * 86400;

  try {
    await env.REPORTS.put("reports/" + id + ".pdf", bytes, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { expires: String(expires), title: input.title || "" },
    });
  } catch (e) {
    return { ok: false, error: "store_failed", message: String(e.message || e) };
  }

  const url = new URL("/r/" + id, request.url).toString();
  return {
    ok: true,
    url,
    bytes: bytes.length,
    expires_days: REPORT_TTL_DAYS,
    note: "Give the person this link as it is. It opens the PDF in a browser and can be forwarded; it stops working after " + REPORT_TTL_DAYS + " days.",
  };
}

async function serveReport(id, env) {
  if (!env.REPORTS || typeof env.REPORTS.get !== "function") return jsonError(404, "not_found");
  if (!/^[0-9a-f]{32}$/.test(id)) return jsonError(404, "not_found");
  let obj;
  try { obj = await env.REPORTS.get("reports/" + id + ".pdf"); } catch (e) { obj = null; }
  if (!obj) return jsonError(404, "not_found");

  const meta = obj.customMetadata || {};
  if (meta.expires && Number(meta.expires) < nowSec()) {
    return jsonError(410, "report_expired");
  }
  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": 'inline; filename="' +
        (meta.title ? meta.title.replace(/[^\w .\-]+/g, "_").slice(0, 60) : "report") + '.pdf"',
      // The link is the secret; nothing else should hold a copy of it.
      "cache-control": "private, max-age=600",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}


// Watches the SSE stream on its way to the browser and pulls the real token
// counts out of it (message_start carries input, message_delta carries
// output). The bytes are passed through untouched.
function meterStream(body, onUsage) {
  let inTok = 0, outTok = 0, searches = 0, buffer = "";
  const decoder = new TextDecoder();
  const ts = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop();
      for (const raw of events) {
        for (const line of raw.split("\n")) {
          if (line.indexOf("data:") !== 0) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const evt = JSON.parse(payload);
            if (evt.type === "message_start" && evt.message && evt.message.usage) {
              inTok = evt.message.usage.input_tokens || 0;
              outTok = evt.message.usage.output_tokens || 0;
              searches = searchesOf(evt.message.usage);
            } else if (evt.type === "message_delta" && evt.usage) {
              if (evt.usage.output_tokens != null) outTok = evt.usage.output_tokens;
              const sn = searchesOf(evt.usage);
              if (sn) searches = sn;
            }
          } catch (e) { /* partial or non-JSON event */ }
        }
      }
    },
    flush() { onUsage(inTok, outTok, searches); }
  });
  return body.pipeThrough(ts);
}

// Anthropic reports server-side tool calls under usage.server_tool_use.
// Each web search is billed per search, so this is a real cost line, not a
// statistic — see eurMicrosFor.
function searchesOf(usage) {
  return (usage && usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
}

// ---------- Stripe (REST over fetch; the node SDK cannot run here) ----------

function formEncode(obj, prefix, out) {
  out = out || new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripeCall(env, path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: formEncode(params).toString()
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data && data.error && data.error.message) || "stripe_error");
  return data;
}

// Stripe signs `${timestamp}.${rawBody}` with the endpoint secret. Verifying
// it is what stops anyone from POSTing themselves a free subscription.
async function verifyStripeSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  let t = null; const sigs = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k === "t") t = v;
    else if (k === "v1") sigs.push(v);
  }
  if (!t || !sigs.length) return false;
  if (Math.abs(nowSec() - Number(t)) > 300) return false; // replay window
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => timingSafeEqual(s, expected));
}

async function ensureStripeCustomer(env, user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const cust = await stripeCall(env, "customers", {
    email: user.email,
    metadata: { user_id: user.id }
  });
  await env.DB.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").bind(cust.id, user.id).run();
  return cust.id;
}

// ---------- HTTP handlers ----------

async function readJson(request) {
  try { return await request.json(); } catch (e) { return null; }
}

function validEmail(e) {
  return typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 254;
}

async function handleSignup(request, env) {
  const body = await readJson(request);
  if (!body || !validEmail(body.email) || typeof body.password !== "string" || body.password.length < 8) {
    return jsonError(400, "invalid_credentials");
  }
  const email = body.email.trim().toLowerCase();
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return jsonError(409, "email_taken");
  const { hash, salt } = await hashPassword(body.password);
  const id = crypto.randomUUID();
  const name = cleanName(body.name);
  await env.DB.prepare(
    "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, email, name, hash, salt, nowSec()).run();
  const token = await createSession(env, id);
  return jsonOk({ ok: true, email, name }, { "set-cookie": sessionCookie(token, SESSION_TTL_SEC) });
}

// The name a person is shown by — in the footer slot and in the cabinet.
// Kept short and stripped of control characters and angle brackets: it is
// always rendered as text, never as markup, but there is no reason to store
// something that would look like markup if some future surface got that wrong.
function cleanName(v) {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 60);
  return s || null;
}

async function handleSetName(request, env) {
  const user = await currentUser(request, env);
  if (!user) return jsonError(401, "sign_in_required");
  const body = await readJson(request);
  const name = cleanName(body && body.name);
  await env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(name, user.id).run();
  return jsonOk({ ok: true, name });
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  if (!body || !validEmail(body.email) || typeof body.password !== "string") {
    return jsonError(400, "invalid_credentials");
  }
  const email = body.email.trim().toLowerCase();
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  // Same answer for "no such account" and "wrong password" — otherwise this
  // endpoint tells an attacker which emails are registered.
  if (!user || !user.password_hash) return jsonError(401, "invalid_credentials");
  const { hash } = await hashPassword(body.password, user.password_salt);
  if (!timingSafeEqual(hash, user.password_hash)) return jsonError(401, "invalid_credentials");
  const token = await createSession(env, user.id);
  return jsonOk({ ok: true, email }, { "set-cookie": sessionCookie(token, SESSION_TTL_SEC) });
}

async function handleLogout(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    const hash = await sha256Hex(token);
    try { await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run(); } catch (e) {}
  }
  return jsonOk({ ok: true }, { "set-cookie": sessionCookie("", 0) });
}

async function handleAccount(request, env, cfg) {
  const user = await currentUser(request, env);
  if (!user) return jsonOk({ signedIn: false, billingEnabled: cfg.billingEnabled });
  const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ?").bind(user.id).first();
  const since = sub && sub.current_period_start ? sub.current_period_start : (nowSec() - 30 * 86400);
  const spent = await usageSince(env, user.id, since);
  const plan = sub ? sub.plan : null;
  const allowance = plan ? (cfg.allowanceEur[plan] || 0) : 0;
  return jsonOk({
    signedIn: true,
    email: user.email,
    name: user.display_name || null,
    billingEnabled: cfg.billingEnabled,
    plan,
    status: sub ? sub.status : null,
    autopay: sub ? !!sub.autopay : false,
    currentPeriodEnd: sub ? sub.current_period_end : null,
    usageEur: +(spent / 1e6).toFixed(4),
    allowanceEur: allowance,
    trial: sub ? null : {
      messagesUsed: Number(user.trial_messages || 0),
      messagesLimit: cfg.trialMessages,
      days: cfg.trialDays,
      startedAt: user.trial_started_at
    }
  });
}

async function handleCheckout(request, env, cfg, url) {
  const user = await currentUser(request, env);
  if (!user) return jsonError(401, "sign_in_required");
  const body = await readJson(request);
  const plan = body && body.plan === "pro" ? "pro" : "standard";
  const price = cfg.priceId[plan];
  if (!price) return jsonError(503, "price_not_configured");
  if (!env.STRIPE_SECRET_KEY) return jsonError(503, "stripe_not_configured");
  const customer = await ensureStripeCustomer(env, user);
  try {
    const session = await stripeCall(env, "checkout/sessions", {
      mode: "subscription",
      customer,
      client_reference_id: user.id,
      success_url: `${url.origin}/account.html?checkout=done`,
      cancel_url: `${url.origin}/account.html?checkout=cancelled`,
      "line_items[0][price]": price,
      "line_items[0][quantity]": 1,
      // Prices are entered in Stripe exclusive of tax; Stripe Tax adds the
      // customer's own rate (21% in Spain) and applies EU B2B reverse charge
      // when a valid VAT number is given.
      "automatic_tax[enabled]": "true",
      "tax_id_collection[enabled]": "true",
      "customer_update[address]": "auto",
      "customer_update[name]": "auto",
      "subscription_data[metadata][user_id]": user.id,
      "subscription_data[metadata][plan]": plan
    });
    return jsonOk({ url: session.url });
  } catch (e) {
    return jsonError(502, String(e.message || "stripe_error"));
  }
}

async function handlePortal(request, env, url) {
  const user = await currentUser(request, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (!user.stripe_customer_id) return jsonError(400, "no_customer");
  if (!env.STRIPE_SECRET_KEY) return jsonError(503, "stripe_not_configured");
  try {
    const session = await stripeCall(env, "billing_portal/sessions", {
      customer: user.stripe_customer_id,
      return_url: `${url.origin}/account.html`
    });
    return jsonOk({ url: session.url });
  } catch (e) {
    return jsonError(502, String(e.message || "stripe_error"));
  }
}

async function upsertSubscription(env, userId, fields) {
  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, plan, status, stripe_subscription_id,
                                current_period_start, current_period_end, autopay, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT autopay FROM subscriptions WHERE user_id = ?), 0), ?)
     ON CONFLICT(user_id) DO UPDATE SET
       plan = excluded.plan,
       status = excluded.status,
       stripe_subscription_id = excluded.stripe_subscription_id,
       current_period_start = excluded.current_period_start,
       current_period_end = excluded.current_period_end,
       updated_at = excluded.updated_at`
  ).bind(userId, fields.plan, fields.status, fields.subId,
         fields.periodStart, fields.periodEnd, userId, nowSec()).run();
}

async function handleStripeWebhook(request, env) {
  const raw = await request.text();
  const ok = await verifyStripeSignature(raw, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return jsonError(400, "bad_signature");

  let evt;
  try { evt = JSON.parse(raw); } catch (e) { return jsonError(400, "bad_payload"); }

  // Stripe retries; a replayed event must be a no-op.
  const seen = await env.DB.prepare("SELECT id FROM stripe_events WHERE id = ?").bind(evt.id).first();
  if (seen) return jsonOk({ received: true, duplicate: true });
  await env.DB.prepare("INSERT INTO stripe_events (id, type, processed_at) VALUES (?, ?, ?)")
    .bind(evt.id, evt.type, nowSec()).run();

  const obj = evt.data && evt.data.object ? evt.data.object : {};

  async function userIdFor(o) {
    if (o.metadata && o.metadata.user_id) return o.metadata.user_id;
    if (o.client_reference_id) return o.client_reference_id;
    const cust = o.customer;
    if (cust) {
      const row = await env.DB.prepare("SELECT id FROM users WHERE stripe_customer_id = ?").bind(cust).first();
      if (row) return row.id;
    }
    return null;
  }

  if (evt.type === "checkout.session.completed" ||
      evt.type === "customer.subscription.created" ||
      evt.type === "customer.subscription.updated") {
    const userId = await userIdFor(obj);
    if (userId) {
      const isSub = evt.type !== "checkout.session.completed";
      const plan = (obj.metadata && obj.metadata.plan) || "standard";
      await upsertSubscription(env, userId, {
        plan,
        status: isSub ? (obj.status || "active") : "active",
        subId: isSub ? obj.id : obj.subscription,
        periodStart: obj.current_period_start || nowSec(),
        periodEnd: obj.current_period_end || null
      });
    }
  } else if (evt.type === "customer.subscription.deleted") {
    const userId = await userIdFor(obj);
    if (userId) {
      await env.DB.prepare(
        "UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE user_id = ?"
      ).bind(nowSec(), userId).run();
    }
  } else if (evt.type === "invoice.payment_failed") {
    const userId = await userIdFor(obj);
    if (userId) {
      await env.DB.prepare(
        "UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE user_id = ?"
      ).bind(nowSec(), userId).run();
    }
  }

  return jsonOk({ received: true });
}

async function routeBilling(request, env, url, cfg) {
  const p = url.pathname;
  const post = request.method === "POST";

  if (p === "/api/stripe/webhook") {
    if (!post) return jsonError(405, "method_not_allowed");
    if (!hasDB(env)) return jsonError(503, "db_not_configured");
    return handleStripeWebhook(request, env);
  }
  if (p.startsWith("/api/auth/") || p.startsWith("/api/account") || p.startsWith("/api/billing/")) {
    if (!hasDB(env)) return jsonError(503, "db_not_configured");
  }
  if (p === "/api/auth/signup" && post) return handleSignup(request, env);
  if (p === "/api/auth/login" && post) return handleLogin(request, env);
  if (p === "/api/auth/logout" && post) return handleLogout(request, env);
  if (p === "/api/account" && request.method === "GET") return handleAccount(request, env, cfg);
  if (p === "/api/account/name" && post) return handleSetName(request, env);
  if (p === "/api/billing/checkout" && post) return handleCheckout(request, env, cfg, url);
  if (p === "/api/billing/portal" && post) return handlePortal(request, env, url);
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Accounts, entitlement and Stripe. Returns null when the path is not
    // one of theirs, so the rest of the router is untouched.
    if (url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/api/account") ||
        url.pathname.startsWith("/api/billing/") || url.pathname === "/api/stripe/webhook") {
      const cfg = hasDB(env) ? await loadSettings(env) : { billingEnabled: false, allowanceEur: {}, priceId: {} };
      const handled = await routeBilling(request, env, url, cfg);
      if (handled) return handled;
      return jsonError(404, "not_found");
    }

    // A report link. Unguessable by its name, expiring by its metadata, and
    // never listed anywhere — the person decides who else sees it.
    if (url.pathname.startsWith("/r/")) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonError(405, "method_not_allowed");
      }
      return serveReport(url.pathname.slice(3), env);
    }

    if (url.pathname === "/api/transcribe") {
      // GET is a health probe, not a transcription. "The microphone is broken"
      // has meant four different things so far — a denied permission, a codec
      // Safari would not produce, our own rate limit, and an empty OpenAI
      // balance — and only one of them is in the browser. This answers which,
      // from any device, without a microphone and without revealing the key.
      if (request.method === "GET") return transcribeHealth(env);
      if (request.method !== "POST") return jsonError(405, "method_not_allowed");
      const cfg = hasDB(env)
        ? await loadSettings(env)
        : { billingEnabled: false, usdToEur: 0.92, anonPerDay: 5, allowanceEur: {}, priceId: {},
            transcribeModel: "gpt-transcribe", transcribeUsdPerMin: 0.0045,
            transcribeMaxSeconds: 120, transcribeMaxBytes: 8000000, transcribeMaxPerHour: 40 };
      return handleTranscribe(request, env, cfg, ctx);
    }

    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") return jsonError(405, "method_not_allowed");

      const cfg = hasDB(env)
        ? await loadSettings(env)
        : { billingEnabled: false, usdToEur: 0.92, trialDays: 14, trialMessages: 25,
            anonPerDay: 5, allowanceEur: {}, priceId: {} };

      // Who is asking, and are they allowed another message? While
      // billing_enabled is '0' this never refuses — it only resolves the
      // actor so usage is recorded truthfully before the switch is thrown.
      const gate = await gateChat(request, env, cfg);
      if (gate.response) return gate.response;

      const res = await handleChatPost(request, env, cfg);

      // Meter the answer on its way out. The bytes are passed through
      // unchanged; the ledger write happens after the last byte, off the
      // response path, so billing can never delay or break a reply.
      const ctype = res.headers.get("content-type") || "";
      if (res.ok && res.body && ctype.indexOf("text/event-stream") !== -1 && hasDB(env)) {
        const model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;
        const metered = meterStream(res.body, (inTok, outTok, searches) => {
          ctx.waitUntil(recordUsage(env, cfg, gate.actor, model, inTok, outTok, searches));
        });
        return new Response(metered, { status: res.status, headers: res.headers });
      }
      return res;
    }

    // Everything else: serve the static site as normal.
    return env.ASSETS.fetch(request);
  }
};
