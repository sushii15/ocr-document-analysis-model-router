# GitHub Launch Checklist

## Repository Setup

- Create a new GitHub repository named `ocr-document-analysis-model-router`.
- Set the repo description: `BYOK model router for OCR document analysis, invoice extraction, bank statement extraction, scanned PDFs, and long PDFs.`
- Add topics: `ocr`, `document-analysis`, `document-ai`, `llm-router`, `model-router`, `model-routing`, `pdf-extraction`, `invoice-extraction`, `bank-statement-extraction`, `bank-statements`, `financial-documents`, `supabase`, `mcp-server`, `byok`, `typescript`.
- Upload `docs/assets/social-preview.png` as the repository social preview image in GitHub settings.
- Pin the demo video or link it in the README.

## Launch Post Angle

Lead with the problem:

> Most document AI stacks either overpay for frontier models or under-route hard OCR jobs to cheap models that fail. This OCR document analysis model router profiles the document first, then chooses the cheapest model that can still extract it correctly.

## Suggested Post

I built a model router for OCR document analysis: BYOK routing for invoices, bank statements, scanned PDFs, and long financial documents.

It runs non-LLM OCR first, profiles the document, ranks the user's enabled AI models by quality/cost/latency, explains the math, executes or dry-runs extraction, then records deterministic eval feedback for a learning layer.

The goal is simple: stop sending every PDF to the most expensive model by default.

Demo + code:
`<github repo url>`

## Best Communities

- Hacker News: Show HN
- Reddit: r/LocalLLaMA, r/MachineLearning, r/programming, r/SaaS, r/SideProject
- LinkedIn: AI builders, document automation, fintech ops
- X/Twitter: build-in-public, AI engineering, OCR/document AI
- Discord/Slack: Supabase, MCP, AI engineer communities

