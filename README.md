# @pipeworx/aemps-cima

AEMPS CIMA — the Spanish Agency for Medicines and Health Products' public register of every medicine authorised for sale in **Spain**: brand/generic search, full authorisation detail, the structured ficha técnica (SmPC) and prospecto (patient leaflet) text, current supply shortages, and a changes-since-date feed.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Scope — Spain, and only Spain

Field values are Spanish (`paracetamol`, `ibuprofeno`, not US brand names). For the equivalent EU-wide register use `ema-medicines`; for the UK use `mhra-uk`; for the US use `openfda`. Tools are prefixed `cima_` so they never win a generic drug question.

## Tools

| Tool | Answers |
|---|---|
| `cima_search_medicines` | *Which Spanish medicines contain ibuprofeno?* — search by name, ingredient, ATC or holder |
| `cima_medicine_detail` | *What is nregistro 77758?* — ingredients+strengths, ATC, form, route, dates |
| `cima_medicine_document_sections` | *What does the label say about dosage?* — the SmPC/leaflet TEXT, section by section, not a PDF link |
| `cima_supply_problems` | *Is there a shortage of X in Spain?* — current/recent AEMPS supply-problem rows |
| `cima_changes_since` | *What changed in the Spanish register this month?* — approvals, label revisions, material updates |

## Auth

Keyless. No registration.

## Data sources

- <https://cima.aemps.es/cima/rest/medicamentos> — search.
- <https://cima.aemps.es/cima/rest/medicamento> — detail by `nregistro`.
- <https://cima.aemps.es/cima/rest/docSegmentado/contenido/{1|2}> — segmented ficha técnica (`1`) / prospecto (`2`) text by `nregistro`.
- <https://cima.aemps.es/cima/rest/psuministro> — supply problems.
- <https://cima.aemps.es/cima/rest/registroCambios> — changes-since-date feed.

### Things the next person would otherwise rediscover

- **An unrecognised query parameter on `/medicamentos` is silently ignored, not rejected** — you get the entire ~25,500-row register back, paginated, `totalFilas` unchanged. Measured: `?xxx=1` → `totalFilas: 25455`, identical to no filter. This pack only ever sends the confirmed filter set (`nombre`, `practiv1`, `atc`, `laboratorio`).
- **`/psuministro` silently ignores `laboratorio`** even though it's a field name on the response objects — `?laboratorio=Teva` returns the same `totalFilas` (866) as no filter at all. Only `nombre` actually filters this endpoint.
- **`/registroCambios` REQUIRES `fecha`, and rejects its absence with an HTTP 200** — `{"error":"Es necesario indicar la fecha"}`, not an HTTP error. A caller that only checks status code reads this as a clean empty success. `fecha` is `dd/MM/yyyy`, not ISO; an ISO date matches nothing. This pack accepts ISO from the caller and converts.
- **Timestamps (`estado.aut`, `estado.rev`, `fini`, `ffin`, `fecha`) are epoch MILLISECONDS**, converted to `YYYY-MM-DD` on the way out.
- **The ficha técnica can run 25-30 sections.** `cima_medicine_document_sections` caps total output around 40,000 characters (each section further capped ~4,000) and flags `truncated: true` per section rather than silently dropping content — pass `seccion` (e.g. `"4.1"`) for one section only when you know which you need.
- **Field values stay in AEMPS's own Spanish wording** (`labtitular`, `cpresc`, `comerc`...) since that's what a Spanish-market query needs to match against; the pack adds English key names alongside the Spanish content rather than translating it.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "aemps-cima": {
      "url": "https://gateway.pipeworx.io/aemps-cima/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/aemps-cima/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/cima_search_medicines \
  -H 'Content-Type: application/json' \
  -d '{"ingredient":"paracetamol","limit":3}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/cima_search_medicines`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "aemps-cima": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-aemps-cima"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-aemps-cima
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Aemps Cima data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
