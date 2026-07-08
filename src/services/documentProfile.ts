import { DocumentDifficulty, DocumentProfile, TaskType } from "../types.js";

const knownDifficultLayouts: Record<string, number> = {
  "bank-of-america.statement.v1": 12,
  "chase.statement.v1": 10,
  "wells-fargo.statement.v1": 10,
  "amex.statement.v1": 9,
  "generic.dense-multi-table": 14,
};

const institutionDifficulty: Array<[RegExp, number, string]> = [
  [/\bbank of america|bofa\b/i, 10, "known bank-statement layout often has dense transaction tables"],
  [/\bchase|jpmorgan\b/i, 8, "known bank-statement layout"],
  [/\bwells fargo\b/i, 8, "known bank-statement layout"],
  [/\bamerican express|amex\b/i, 7, "statement layout with category/merchant variations"],
  [/\bciti|citibank\b/i, 7, "known statement layout"],
];

export function evaluateDocumentDifficulty(prompt: string, profile?: DocumentProfile, explicitTask?: TaskType, stepType?: string): DocumentDifficulty {
  const reasons: string[] = [];
  let score = 0;
  const inferredTask = explicitTask || inferTaskFromProfile(profile) || inferTaskFromText(`${stepType || ""}\n${prompt}`);
  const pageCount = profile?.page_count || inferNumber(prompt, /\b(\d+)\s*(?:pages|page)\b/i) || 0;
  const characterCount = profile?.character_count || prompt.length;

  if (pageCount >= 50) add(28, `${pageCount} pages`);
  else if (pageCount >= 20) add(20, `${pageCount} pages`);
  else if (pageCount >= 6) add(10, `${pageCount} pages`);
  else if (pageCount > 0) add(2, `${pageCount} pages`);

  if (characterCount >= 120000) add(24, `${characterCount} characters`);
  else if (characterCount >= 40000) add(16, `${characterCount} characters`);
  else if (characterCount >= 10000) add(8, `${characterCount} characters`);

  if (profile?.has_text_layer === true && profile.text_layer_quality === "good") add(-16, "good embedded text layer");
  if (profile?.has_text_layer === true && profile.text_layer_quality === "partial") add(-6, "partial embedded text layer");
  if (profile?.has_text_layer === false || profile?.text_layer_quality === "none") add(12, "no embedded text layer");
  if (profile?.text_layer_quality === "poor") add(8, "poor embedded text layer");

  if (profile?.document_type === "bank_statement") add(14, "bank statement");
  if (profile?.document_type === "invoice") add(4, "invoice");
  if (["contract", "loan_document", "financial_report"].includes(profile?.document_type || "")) add(12, `${profile?.document_type} document`);

  if (profile?.layout_complexity === "table_heavy") add(14, "table-heavy layout");
  if (profile?.layout_complexity === "dense") add(12, "dense layout");
  if (profile?.layout_complexity === "multi_column") add(10, "multi-column layout");
  if (profile?.layout_complexity === "mixed") add(6, "mixed layout");

  if (profile?.has_tables) add(8, "contains tables");
  if ((profile?.table_count || 0) >= 5) add(8, `${profile?.table_count} tables`);
  if ((profile?.table_density || 0) >= 0.6) add(12, "high table density");
  else if ((profile?.table_density || 0) >= 0.3) add(6, "medium table density");

  if (profile?.has_handwriting) add(22, "handwriting detected");
  if (profile?.image_quality === "low") add(18, "low image quality");
  if (profile?.image_quality === "medium") add(6, "medium image quality");
  if (profile?.requires_reconciliation) add(10, "requires reconciliation");
  if (profile?.prior_validation_failed) add(18, "prior validation failed");
  if ((profile?.confidence || 1) < 0.65) add(8, "low preflight confidence");

  if (profile?.known_layout_id && knownDifficultLayouts[profile.known_layout_id]) {
    add(knownDifficultLayouts[profile.known_layout_id], `known layout ${profile.known_layout_id}`);
  }
  if (profile?.source_institution) {
    for (const [regex, points, reason] of institutionDifficulty) {
      if (regex.test(profile.source_institution)) {
        add(points, reason);
        break;
      }
    }
  }

  if (/\b(transaction history|running balance|opening balance|closing balance)\b/i.test(prompt)) add(8, "transaction/balance language");
  if (/\b(rotated|skewed|blurred|low resolution|poor scan)\b/i.test(prompt)) add(12, "scan quality issue in prompt");
  if (/\b(nested table|merged cells|multi-column|multi column)\b/i.test(prompt)) add(10, "complex table language");

  const bounded = Math.max(0, Math.min(100, score));
  return {
    score: bounded,
    complexity: bounded >= 55 ? "high" : bounded >= 25 ? "medium" : "low",
    reasons: reasons.slice(0, 8),
    recommendedTaskType: inferredTask,
  };

  function add(points: number, reason: string) {
    score += points;
    if (points !== 0) reasons.push(`${points > 0 ? "+" : ""}${points}: ${reason}`);
  }
}

function inferTaskFromProfile(profile?: DocumentProfile): TaskType | undefined {
  if (!profile) return undefined;
  if (profile.has_handwriting) return "handwriting_extraction";
  if (profile.document_type === "bank_statement") return "bank_statement_extraction";
  if (profile.document_type === "invoice" || profile.document_type === "receipt") return "invoice_extraction";
  if (profile.requires_reconciliation) return "reconciliation";
  if (profile.has_tables || (profile.table_count || 0) > 0) return "table_extraction";
  if (["contract", "loan_document", "financial_report"].includes(profile.document_type || "")) return "long_document_extraction";
  if (profile.document_type && profile.document_type !== "unknown") return "field_extraction";
  return undefined;
}

function inferTaskFromText(text: string): TaskType {
  const signals: Array<[RegExp, TaskType]> = [
    [/\b(bank statement|statement|transaction|debit|credit|balance|account number|routing number)\b/i, "bank_statement_extraction"],
    [/\b(invoice|receipt|purchase order|po number|vendor|subtotal|tax|line item|amount due)\b/i, "invoice_extraction"],
    [/\b(long document|contract|policy|prospectus|annual report|hundreds of pages|multi-page|multi page)\b/i, "long_document_extraction"],
    [/\b(table|tabular|columns|rows|line items|transaction table|schedule)\b/i, "table_extraction"],
    [/\b(handwriting|handwritten|cursive|signature|scanned form)\b/i, "handwriting_extraction"],
    [/\b(classify|detect document type|document type|is this an invoice|is this a statement)\b/i, "document_classification"],
    [/\b(reconcile|balance|match totals|sum transactions|line item total|debits and credits)\b/i, "reconciliation"],
    [/\b(validate|validation|required fields|schema|confidence|verify totals)\b/i, "validation"],
    [/\b(ocr|scan|scanned|image pdf|extract text|text layer|read pdf)\b/i, "ocr"],
    [/\b(extract|parse|pdf|document|field|structured data|json)\b/i, "field_extraction"],
  ];
  return signals.find(([regex]) => regex.test(text))?.[1] || "unknown";
}

function inferNumber(text: string, regex: RegExp) {
  const match = text.match(regex);
  return match ? Number(match[1]) : undefined;
}
