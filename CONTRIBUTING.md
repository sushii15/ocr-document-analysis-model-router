# Contributing

DocRouter is focused on OCR/document extraction routing, not general chatbot routing. Good contributions usually improve one of these areas:

- OCR/document profiling signals.
- Routing heuristics and lookup tables.
- Model catalog pricing/capability metadata.
- Deterministic extraction eval checks.
- Supabase persistence and learning-layer schema.
- Dashboard clarity and demo quality.

## Local Setup

```bash
npm install
npm run build
$env:TRANSPORT="http"; node dist/index.js
```

Open `http://localhost:3100/v2.html?demo=1` for a no-key demo.

## Before Opening a PR

```bash
npm test
```

Please include:

- What document type or routing behavior changed.
- Before/after behavior.
- Any new env vars or migrations.
- Screenshots or a short clip for UI changes.

Do not commit `.env`, `.docrouter`, provider keys, uploads, or private sample documents.

