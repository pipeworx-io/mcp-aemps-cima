interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * AEMPS CIMA — the Spanish Agency for Medicines and Health Products' public
 * register of every medicine authorised for sale in SPAIN (cima.aemps.es).
 * Documented, keyless JSON REST API, no auth, no rate-limit wall observed.
 *
 * Tools:
 * - cima_search_medicines: search the register by brand/product name, active
 *   ingredient, ATC code or marketing-authorisation holder (laboratorio).
 * - cima_medicine_detail: full record for one medicine by its nregistro
 *   (Spanish national registration number) — active ingredients with
 *   strengths, excipients, ATC codes, prescription status, document links.
 * - cima_medicine_document_sections: the STRUCTURED ficha técnica (SmPC) or
 *   prospecto (patient leaflet) for one medicine, section by section, from
 *   AEMPS's own segmented-document endpoint — not a PDF link, the actual
 *   section text.
 * - cima_supply_problems: current and recent Spanish drug-supply shortages
 *   (problemas de suministro), the AEMPS counterpart of the FDA/EMA shortage
 *   databases.
 * - cima_changes_since: which medicine records AEMPS has changed since a
 *   given date — approvals, label updates, material changes, etc.
 *
 * Fields are kept in AEMPS's own Spanish wording (`nombre`, `labtitular`,
 * `cpresc`...) because that is what a Spanish-market query needs to match
 * against; English labels are added alongside for the fields an agent is
 * most likely to filter or read at a glance (see PxWeb precedent: native ids,
 * English labels — memory/reference_pxweb_native_slugs).
 *
 * THREE TRAPS, all silent-200s:
 *
 * 1. AN UNKNOWN QUERY PARAMETER ON /medicamentos IS IGNORED, NOT REJECTED —
 *    you get the entire 25,000+ row register back, paginated, with totalFilas
 *    unchanged. Measured: ?xxx=1 returns totalFilas:25455, identical to no
 *    filter at all. So requests are built ONLY from the confirmed filter set
 *    (nombre, practiv1, atc, laboratorio, cn) — never from a caller key passed
 *    straight through.
 *
 * 2. /psuministro (supply problems) SILENTLY IGNORES `laboratorio` — it is a
 *    valid-looking field name on the response objects but is NOT a filter
 *    parameter; ?laboratorio=Teva returns the same totalFilas as no filter at
 *    all (866). Only `nombre` actually filters this endpoint. Client-side
 *    filtering by laboratorio would be needed for that facet; not implemented
 *    here to avoid silently claiming a filter that does not work upstream.
 *
 * 3. /registroCambios REQUIRES `fecha` — omitting it is a 200 with
 *    `{"error":"Es necesario indicar la fecha"}`, not an HTTP error, so a
 *    caller that didn't check the body would read this as success with no
 *    rows. `fecha` is dd/MM/yyyy, not ISO — an ISO date silently matches
 *    nothing on this upstream, so this pack converts for the caller.
 *
 * Timestamps in `estado.aut` / `estado.rev` etc. are epoch MILLISECONDS —
 * converted to ISO 8601 dates on the way out.
 */


const BASE = 'https://cima.aemps.es/cima/rest';
const UA = 'pipeworx-aemps-cima-mcp/1.0 (+https://pipeworx.io)';
const SOURCE = 'AEMPS CIMA (Centro de Información online de Medicamentos, Spain)';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(
    url,
    { ...init, headers: { Accept: 'application/json', 'User-Agent': UA, ...(init?.headers ?? {}) } },
    'AEMPS CIMA',
  );
}

async function cimaGet<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  const url = `${BASE}${path}${qs.toString() ? `?${qs}` : ''}`;
  const res = await pwFetch(url);
  if (!res.ok) throw await httpError(res, 'AEMPS CIMA');
  return res.json() as Promise<T>;
}

const clamp = (n: unknown, d: number, max: number) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : d;
};

const msToIso = (ms: unknown): string | null =>
  typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;

function notFound(reason: string, hint: string, extra: Record<string, unknown> = {}) {
  return { found: false, reason, hint, source: SOURCE, jurisdiction: 'Spain', ...extra };
}

// ---- shapes -----------------------------------------------------------

interface SearchRow {
  nregistro: string;
  nombre: string;
  labtitular?: string;
  labcomercializador?: string;
  cpresc?: string;
  estado?: { aut?: number; rev?: number; susp?: number; rev2?: number };
  comerc?: boolean;
  receta?: boolean;
  generico?: boolean;
  huerfano?: boolean;
  biosimilar?: boolean;
  psum?: boolean;
  dosis?: string;
  vtm?: { id?: number; nombre?: string };
  docs?: { tipo?: number; url?: string; urlHtml?: string }[];
}

const shapeSearchRow = (r: SearchRow) => ({
  nregistro: r.nregistro,
  nombre: r.nombre,
  active_ingredient: r.vtm?.nombre ?? null, // English: the medicine's active-substance name (VTM)
  dosis: r.dosis ?? null,
  laboratorio_titular: r.labtitular ?? null,
  laboratorio_comercializador: r.labcomercializador ?? null,
  prescripcion: r.cpresc ?? null,
  autorizado_desde: msToIso(r.estado?.aut), // English: authorised-since date
  comercializado: r.comerc ?? null, // English: currently marketed
  receta: r.receta ?? null, // English: prescription-only
  generico: r.generico ?? null, // English: generic
  huerfano: r.huerfano ?? null, // English: orphan-drug designation
  biosimilar: r.biosimilar ?? null,
  en_problema_suministro: r.psum ?? null, // English: currently has a supply problem
  ficha_tecnica_url: r.docs?.find((d) => d.tipo === 1)?.urlHtml ?? null,
  prospecto_url: r.docs?.find((d) => d.tipo === 2)?.urlHtml ?? null,
});

async function searchMedicines(a: Record<string, unknown>) {
  const name = a.name != null ? String(a.name).trim() : '';
  const ingredient = a.ingredient != null ? String(a.ingredient).trim() : '';
  const atc = a.atc != null ? String(a.atc).trim() : '';
  const lab = a.lab != null ? String(a.lab).trim() : '';
  if (!name && !ingredient && !atc && !lab) {
    return notFound(
      'no_search_terms',
      'Pass at least one of name, ingredient, atc, or lab. Example: {"ingredient": "paracetamol"}.',
    );
  }
  const limit = clamp(a.limit, 25, 200);

  const data = await cimaGet<{ totalFilas: number; resultados?: SearchRow[] }>('/medicamentos', {
    nombre: name || undefined,
    practiv1: ingredient || undefined,
    atc: atc || undefined,
    laboratorio: lab || undefined,
    pagina: 1,
  });

  const rows = data.resultados ?? [];
  if (!rows.length) {
    return notFound(
      'no_medicines_found',
      'No Spanish-authorised medicine matched. AEMPS field values are Spanish (e.g. "paracetamol", "ibuprofeno") — try the INN/Spanish DCI name rather than a US brand name.',
      { name: name || null, ingredient: ingredient || null, atc: atc || null, lab: lab || null },
    );
  }
  return {
    source: SOURCE,
    jurisdiction: 'Spain',
    query: { name: name || null, ingredient: ingredient || null, atc: atc || null, lab: lab || null },
    total_matches: data.totalFilas,
    truncated: rows.length > limit || data.totalFilas > rows.length,
    medicines: rows.slice(0, limit).map(shapeSearchRow),
  };
}

async function medicineDetail(a: Record<string, unknown>) {
  const nregistro = a.nregistro != null ? String(a.nregistro).trim() : '';
  if (!nregistro) {
    return notFound('no_nregistro', 'Pass nregistro, the Spanish national registration number, e.g. {"nregistro": "77758"}. Find it with cima_search_medicines.');
  }
  const res = await pwFetch(`${BASE}/medicamento?nregistro=${encodeURIComponent(nregistro)}`);
  if (res.status === 404) {
    return notFound('nregistro_not_found', `No AEMPS record for nregistro "${nregistro}". Find a valid one with cima_search_medicines.`, { nregistro });
  }
  if (!res.ok) throw await httpError(res, 'AEMPS CIMA');
  const d = (await res.json()) as any;
  return {
    source: SOURCE,
    jurisdiction: 'Spain',
    nregistro: d.nregistro,
    nombre: d.nombre,
    principios_activos: (d.principiosActivos ?? []).map((p: any) => ({
      nombre: p.nombre,
      cantidad: p.cantidad ?? null,
      unidad: p.unidad ?? null,
    })), // English: active ingredients with strength
    excipientes: (d.excipientes ?? []).map((e: any) => e.nombre).filter(Boolean), // English: excipients
    atcs: (d.atcs ?? []).map((c: any) => ({ codigo: c.codigo, nombre: c.nombre, nivel: c.nivel })),
    forma_farmaceutica: d.formaFarmaceutica?.nombre ?? null, // English: pharmaceutical form
    vias_administracion: (d.viasAdministracion ?? []).map((v: any) => v.nombre), // English: routes of administration
    laboratorio_titular: d.labtitular ?? null,
    laboratorio_comercializador: d.labcomercializador ?? null,
    prescripcion: d.cpresc ?? null,
    autorizado_desde: msToIso(d.estado?.aut),
    ultima_revision: msToIso(d.estado?.rev), // English: last label-revision date
    comercializado: d.comerc ?? null,
    receta: d.receta ?? null,
    generico: d.generico ?? null,
    huerfano: d.huerfano ?? null,
    biosimilar: d.biosimilar ?? null,
    en_problema_suministro: d.psum ?? null,
    ficha_tecnica_pdf: d.docs?.find((x: any) => x.tipo === 1)?.url ?? null,
    ficha_tecnica_html: d.docs?.find((x: any) => x.tipo === 1)?.urlHtml ?? null,
    prospecto_pdf: d.docs?.find((x: any) => x.tipo === 2)?.url ?? null,
    prospecto_html: d.docs?.find((x: any) => x.tipo === 2)?.urlHtml ?? null,
    note: 'Use cima_medicine_document_sections for the actual ficha técnica / prospecto TEXT rather than the PDF link.',
  };
}

const DOC_TYPE: Record<string, number> = { ficha_tecnica: 1, prospecto: 2 };
const MAX_SECTION_CHARS = 4000;
const MAX_TOTAL_CHARS = 40000;

async function documentSections(a: Record<string, unknown>) {
  const nregistro = a.nregistro != null ? String(a.nregistro).trim() : '';
  if (!nregistro) {
    return notFound('no_nregistro', 'Pass nregistro, e.g. {"nregistro": "77758"}. Find it with cima_search_medicines.');
  }
  const docType = String(a.document ?? 'ficha_tecnica').trim();
  const tipo = DOC_TYPE[docType];
  if (!tipo) {
    return notFound('bad_document_type', `document must be "ficha_tecnica" (SmPC) or "prospecto" (patient leaflet), got "${docType}".`, { nregistro });
  }
  const seccion = a.seccion != null ? String(a.seccion).trim() : '';

  const res = await pwFetch(`${BASE}/docSegmentado/contenido/${tipo}?nregistro=${encodeURIComponent(nregistro)}`);
  if (res.status === 404) {
    return notFound(
      'no_sections',
      `AEMPS has no segmented ${docType} for nregistro "${nregistro}" — the medicine may only publish a PDF. Check ficha_tecnica_html/prospecto_html from cima_medicine_detail instead.`,
      { nregistro, document: docType },
    );
  }
  if (!res.ok) throw await httpError(res, 'AEMPS CIMA');
  const rows = (await res.json()) as { seccion: string; titulo: string; contenido: string; orden?: number }[];
  if (!Array.isArray(rows) || !rows.length) {
    return notFound('no_sections', `No sections returned for nregistro "${nregistro}" (${docType}).`, { nregistro, document: docType });
  }

  const filtered = seccion ? rows.filter((r) => r.seccion === seccion || r.seccion.startsWith(`${seccion}.`)) : rows;
  if (seccion && !filtered.length) {
    return notFound(
      'section_not_found',
      `No section "${seccion}" in the ${docType} for nregistro "${nregistro}". Omit seccion to list every section number and title.`,
      { nregistro, document: docType, available_sections: rows.map((r) => ({ seccion: r.seccion, titulo: r.titulo })) },
    );
  }

  let budget = MAX_TOTAL_CHARS;
  const sections = filtered.map((r) => {
    const clean = stripMarkup(r.contenido ?? '');
    const allowed = Math.max(0, Math.min(MAX_SECTION_CHARS, budget));
    const truncated = clean.length > allowed;
    budget -= Math.min(clean.length, allowed);
    return { seccion: r.seccion, titulo: r.titulo, contenido: clean.slice(0, allowed), truncated };
  });

  return {
    source: SOURCE,
    jurisdiction: 'Spain',
    nregistro,
    document: docType,
    section_count: rows.length,
    sections,
  };
}

interface SupplyRow {
  cn?: string;
  nombre: string;
  tipoProblemaSuministro?: number;
  fini?: number;
  ffin?: number;
  activo: boolean;
  observ?: string;
}

async function supplyProblems(a: Record<string, unknown>) {
  const name = a.name != null ? String(a.name).trim() : '';
  const limit = clamp(a.limit, 50, 200);

  const data = await cimaGet<{ totalFilas: number; resultados?: SupplyRow[] }>('/psuministro', {
    nombre: name || undefined,
  });
  const rows = data.resultados ?? [];
  const active = rows.filter((r) => r.activo);
  if (!rows.length) {
    return notFound(
      'no_supply_problems',
      name
        ? `No AEMPS supply-problem record matches "${name}". Only the medicine's registered name filters this endpoint (not the lab/sponsor).`
        : 'No supply-problem rows currently on record.',
      { name: name || null },
    );
  }
  return {
    source: SOURCE,
    jurisdiction: 'Spain',
    query: { name: name || null },
    total_matches: data.totalFilas,
    active_count: active.length,
    truncated: rows.length > limit,
    problems: rows.slice(0, limit).map((r) => ({
      codigo_nacional: r.cn ?? null, // English: national product code (CN)
      nombre: r.nombre,
      tipo_problema_suministro: r.tipoProblemaSuministro ?? null, // English: AEMPS internal shortage-type code
      fecha_inicio: msToIso(r.fini), // English: start date
      fecha_fin_prevista: msToIso(r.ffin), // English: expected end date (may be null = open-ended)
      activo: r.activo, // English: currently in effect
      observaciones: r.observ ?? null,
    })),
  };
}

async function changesSince(a: Record<string, unknown>) {
  const fechaRaw = a.since != null ? String(a.since).trim() : '';
  if (!fechaRaw) {
    return notFound('no_since_date', 'Pass since as an ISO date, e.g. {"since": "2026-08-27"}. registroCambios requires a date; AEMPS rejects the call without one.');
  }
  const m = fechaRaw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const fecha = m ? `${m[3]}/${m[2]}/${m[1]}` : fechaRaw; // AEMPS wants dd/MM/yyyy, not ISO
  const limit = clamp(a.limit, 50, 200);

  const res = await pwFetch(`${BASE}/registroCambios?fecha=${encodeURIComponent(fecha)}`);
  if (!res.ok) throw await httpError(res, 'AEMPS CIMA');
  const data = (await res.json()) as { totalFilas?: number; error?: string; resultados?: any[] };
  if (data.error) {
    return notFound('upstream_rejected_date', `AEMPS rejected the date: "${data.error}". Pass since as YYYY-MM-DD.`, { since: fechaRaw });
  }
  const rows = data.resultados ?? [];
  if (!rows.length) {
    return notFound('no_changes', `No AEMPS record changes on or after ${fechaRaw}.`, { since: fechaRaw });
  }
  return {
    source: SOURCE,
    jurisdiction: 'Spain',
    since: fechaRaw,
    total_matches: data.totalFilas ?? rows.length,
    truncated: rows.length > limit,
    changes: rows.slice(0, limit).map((r) => ({
      nregistro: r.nregistro,
      nombre: r.nombre,
      laboratorio_titular: r.labtitular ?? null,
      fecha: msToIso(r.fecha),
      tipo_cambio: r.tipoCambio ?? null, // English: AEMPS internal change-type code
      cambio: r.cambio ?? [], // English: change category tags, e.g. ["matinf"] = material informativo
    })),
  };
}

// ---- tool defs ----------------------------------------------------------

const tools: McpToolExport['tools'] = [
  {
    name: 'cima_search_medicines',
    description:
      'Search AEMPS CIMA — the register of every medicine authorised for sale in SPAIN — by brand/product name, active ingredient (INN/DCI), ATC code, or marketing-authorisation holder (laboratorio). Returns each medicine\'s nregistro (Spanish national registration number), the active substance, dosage, prescription status, marketed/generic/orphan/biosimilar flags, and links to its ficha técnica (SmPC) and prospecto (patient leaflet). Field values and matching are SPANISH: search "paracetamol" or "ibuprofeno", not a US brand name. Answers "is X authorised in Spain", "which Spanish medicines contain ibuprofeno", "Spanish generics of atorvastatin". Example: cima_search_medicines({ ingredient: "paracetamol" }); cima_search_medicines({ name: "Nolotil" }); cima_search_medicines({ atc: "N02BE01" }). Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Brand/product name, Spanish spelling, e.g. "Nolotil", "Paracetamol Cinfa"' },
        ingredient: { type: 'string', description: 'Active ingredient (INN/DCI, Spanish form), e.g. "paracetamol", "ibuprofeno", "amoxicilina"' },
        atc: { type: 'string', description: 'ATC code, e.g. "N02BE01"' },
        lab: { type: 'string', description: 'Marketing-authorisation holder (laboratorio titular), e.g. "Cinfa"' },
        limit: { type: 'number', description: 'Max medicines to return (default 25, max 200)' },
      },
    },
  },
  {
    name: 'cima_medicine_detail',
    description:
      'Full AEMPS CIMA record for one Spanish-authorised medicine, by nregistro (the Spanish national registration number, from cima_search_medicines). Returns active ingredients with exact strength, excipients, ATC codes, pharmaceutical form, routes of administration, prescription status, authorisation and last-revision dates, and PDF/HTML links to the ficha técnica and prospecto. For the actual document TEXT (not just the link) use cima_medicine_document_sections. Example: cima_medicine_detail({ nregistro: "77758" }). Keyless.',
    inputSchema: {
      type: 'object',
      properties: { nregistro: { type: 'string', description: 'Spanish national registration number, e.g. "77758"' } },
      required: ['nregistro'],
    },
  },
  {
    name: 'cima_medicine_document_sections',
    description:
      'The STRUCTURED text of a Spanish medicine\'s ficha técnica (Summary of Product Characteristics) or prospecto (patient information leaflet), section by section, from AEMPS\'s own segmented-document endpoint — not a PDF link. Ficha técnica sections cover indications (4.1), dosage (4.2), contraindications (4.3), warnings (4.4), interactions (4.5), pregnancy/lactation (4.6), adverse effects (4.8), overdose (4.9). Pass seccion (e.g. "4.1") to fetch one section only; omit it to get every section (each capped at ~4000 chars to keep the payload bounded — the response says which sections were truncated). Example: cima_medicine_document_sections({ nregistro: "77758", document: "ficha_tecnica", seccion: "4.1" }); cima_medicine_document_sections({ nregistro: "77758", document: "prospecto" }). Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        nregistro: { type: 'string', description: 'Spanish national registration number, e.g. "77758"' },
        document: { type: 'string', enum: ['ficha_tecnica', 'prospecto'], description: 'ficha_tecnica = SmPC (prescriber label); prospecto = patient leaflet. Default ficha_tecnica.' },
        seccion: { type: 'string', description: 'One section number to fetch alone, e.g. "4.1" (indications). Omit for every section.' },
      },
      required: ['nregistro'],
    },
  },
  {
    name: 'cima_supply_problems',
    description:
      'Current and recent medicine-supply shortages in Spain (problemas de suministro) from AEMPS — the Spanish counterpart of the FDA/EMA shortage databases. Returns the affected product, national code (CN), AEMPS shortage-type code, start date, expected end date (open-ended if none), whether it is still active, and AEMPS\'s own observation text (often naming an alternative). Only the product name filters this endpoint upstream (not the lab). Answers "is there a shortage of X in Spain", "current Spanish drug supply problems". Example: cima_supply_problems({}); cima_supply_problems({ name: "eltrombopag" }). Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Medicine name to filter by, e.g. "eltrombopag". Omit for all current supply problems.' },
        limit: { type: 'number', description: 'Max rows to return (default 50, max 200)' },
      },
    },
  },
  {
    name: 'cima_changes_since',
    description:
      'Which Spanish medicine records AEMPS has changed on or after a given date — new authorisations, label revisions, material-informativo updates, etc. — from CIMA\'s registroCambios feed. Returns nregistro, name, holder, the change date, and AEMPS\'s change-category tags. Useful for "what changed in the Spanish medicines register this month" or watching one drug for label updates. Example: cima_changes_since({ since: "2026-08-27" }). Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO date, e.g. "2026-08-27" — returns changes on or after this date.' },
        limit: { type: 'number', description: 'Max rows to return (default 50, max 200)' },
      },
      required: ['since'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'cima_search_medicines': return searchMedicines(args);
    case 'cima_medicine_detail': return medicineDetail(args);
    case 'cima_medicine_document_sections': return documentSections(args);
    case 'cima_supply_problems': return supplyProblems(args);
    case 'cima_changes_since': return changesSince(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool } satisfies McpToolExport;
