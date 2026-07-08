# Document Routing Logic

DocRouter routes from a `document_profile`, not from a single prompt keyword.

## Profile Fields

```json
{
  "file_type": "pdf",
  "page_count": 32,
  "character_count": 85000,
  "has_text_layer": false,
  "text_layer_quality": "none",
  "document_type": "bank_statement",
  "source_institution": "Bank of America",
  "known_layout_id": "bank-of-america.statement.v1",
  "image_quality": "medium",
  "layout_complexity": "table_heavy",
  "has_tables": true,
  "table_count": 12,
  "table_density": 0.78,
  "has_handwriting": false,
  "requires_reconciliation": true,
  "contains_financial_data": true,
  "target_schema": "bank_statement_v1",
  "prior_validation_failed": false,
  "confidence": 0.82
}
```

## Difficulty Score

The router computes a 0-100 difficulty score.

| Condition | Points |
|---|---:|
| `page_count >= 50` | +28 |
| `page_count >= 20` | +20 |
| `page_count >= 6` | +10 |
| `character_count >= 120000` | +24 |
| `character_count >= 40000` | +16 |
| `character_count >= 10000` | +8 |
| good text layer | -16 |
| partial text layer | -6 |
| no text layer | +12 |
| poor text layer | +8 |
| bank statement | +14 |
| invoice | +4 |
| contract / loan / financial report | +12 |
| table-heavy layout | +14 |
| dense layout | +12 |
| multi-column layout | +10 |
| mixed layout | +6 |
| contains tables | +8 |
| `table_count >= 5` | +8 |
| `table_density >= 0.6` | +12 |
| `table_density >= 0.3` | +6 |
| handwriting | +22 |
| low image quality | +18 |
| medium image quality | +6 |
| requires reconciliation | +10 |
| prior validation failed | +18 |
| preflight confidence `< 0.65` | +8 |
| known difficult bank/layout | +7 to +14 |

## Complexity Bands

| Score | Complexity |
|---:|---|
| `0-24` | low |
| `25-54` | medium |
| `55-100` | high |

## Known Layout Examples

| Layout / Institution | Points |
|---|---:|
| `bank-of-america.statement.v1` | +12 |
| `chase.statement.v1` | +10 |
| `wells-fargo.statement.v1` | +10 |
| `amex.statement.v1` | +9 |
| `generic.dense-multi-table` | +14 |

## Routing Examples

| Profile | Expected Route |
|---|---|
| 2-page invoice, good text layer, simple layout | low `invoice_extraction`, prefer `small/nano` |
| 32-page Bank of America statement, no text layer, table-heavy, reconciliation | high `bank_statement_extraction`, prefer `frontier/mid` |
| 40-page financial report, partial text layer, dense tables | high `table_extraction`, prefer `frontier/mid` |
| one-page unknown PDF with good text | low `document_classification`, prefer `nano/small` |
| invoice with prior validation failure | escalates via higher difficulty score |

## Decision Rule

Document type chooses the extraction task. Other profile features raise or lower difficulty. Difficulty chooses preferred tiers. The final model still passes through policy filters, cost/quality/latency scoring, and learned outcome scores.
