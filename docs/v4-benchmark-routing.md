# V4 Benchmark-Backed Routing Logic

V4 keeps the deterministic V3 router, then adds a benchmark-informed prior layer for document OCR and document analysis. It does not call an AI model to explain or rank. It reads the document profile produced by the V4 preflight analyzer, maps that profile into benchmark categories, adjusts model quality fit, and then re-ranks with the selected goal.

## Sources Used

- MMR-Bench: routing method and cost-aware selection logic for multimodal models under budget constraints.
- MMDocBench: document family/task priors for receipts, financial reports, tables, charts, infographics, and research-style layouts.
- CC-OCR V2: OCR-specific task priors for text recognition, document parsing, document grounding, key information extraction, and document QA.

The current implementation uses benchmark-informed priors, not exact leaderboard reproduction. Exact per-category scores can be added later if we import benchmark result tables or run our candidate model set against the datasets.

## Input To The Router

The V4 router receives:

- File modality: PDF, image, TIFF, or unknown.
- Text layer quality: good, partial, poor, none, or unknown.
- Page count and character count.
- Document type: invoice, bank statement, receipt, tax form, loan document, financial report, or unknown.
- Image quality and OCR confidence.
- Layout complexity.
- Table detection signals: table count, table density, table-like rows.
- Financial/reconciliation signals.
- Requested extraction task.
- User goal: balanced, best quality, lowest cost, or fastest.

## Benchmark Category Mapping

The document profile is mapped into categories such as:

- `text_pdf`
- `scanned_pdf`
- `image_document`
- `photographed_document`
- `financial_doc`
- `table_doc`
- `dense_table`
- `numeric_financial`
- `reconciliation`
- `multi_page`
- `long_context`
- `text_recognition`
- `document_parsing`
- `key_information_extraction`
- `document_qa`

These categories are the bridge between raw PDF/image signals and the benchmark-backed rules.

## Scoring Formula

V3 first computes:

```text
cost_score
quality_score
latency_score
document_fit_score
tier_bonus
```

V4 then computes:

```text
benchmark_prior_score = sum(category/model priors)
v4_quality_score = clamp(v3_quality_score + benchmark_prior_score, 0.01, 0.99)
```

For balanced mode:

```text
score =
  v4_quality_score * quality_weight
  + cost_score * cost_weight
  + latency_score * latency_weight
  + tier_bonus
```

For single-goal modes:

```text
best_quality = v4_quality_score
lowest_cost = cost_score
fastest = latency_score
```

The explanation shown in the UI is generated from these numbers and the matched rules.
