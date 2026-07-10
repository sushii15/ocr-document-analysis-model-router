export type ModelProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "mistral"
  | "meta"
  | "qwen"
  | "deepseek";

export type ModelTier = "nano" | "small" | "mid" | "frontier";
export type ModelHosting = "cloud" | "self-hosted" | "local";
export type RoutingStrategy = "cost" | "quality" | "latency" | "balanced";

export type TaskType =
  | "ocr"
  | "document_classification"
  | "field_extraction"
  | "table_extraction"
  | "invoice_extraction"
  | "bank_statement_extraction"
  | "long_document_extraction"
  | "handwriting_extraction"
  | "validation"
  | "reconciliation"
  | "unknown";

export interface ModelSpec {
  id: string;
  name: string;
  provider: ModelProvider;
  tier: ModelTier;
  hosting: ModelHosting;
  costPer1kInputTokens: number;
  costPer1kOutputTokens: number;
  contextWindow: number;
  avgLatencyMs: number;
  supportsVision: boolean;
  supportsFunctionCalling: boolean;
  supportsStructuredOutput: boolean;
  maxOutputTokens: number;
  qualityScore: number;
  complianceTags: string[];
  isOpenWeight: boolean;
}

export interface RoutingPolicy {
  strategy?: RoutingStrategy;
  maxCostPer1kTokens?: number;
  maxLatencyMs?: number;
  minQualityScore?: number;
  requiredCompliance?: string[];
  allowedModels?: string[];
  allowedTiers?: ModelTier[];
  allowedProviders?: ModelProvider[];
  allowSelfHosted?: boolean;
  forceTier?: ModelTier;
}

export type DocumentType =
  | "invoice"
  | "bank_statement"
  | "receipt"
  | "tax_form"
  | "contract"
  | "loan_document"
  | "financial_report"
  | "unknown";

export type ImageQuality = "high" | "medium" | "low" | "unknown";
export type LayoutComplexity = "simple" | "mixed" | "table_heavy" | "dense" | "multi_column" | "unknown";

export interface DocumentProfile {
  file_type?: "pdf" | "image" | "tiff" | "unknown";
  page_count?: number;
  character_count?: number;
  has_text_layer?: boolean;
  text_layer_quality?: "good" | "partial" | "poor" | "none" | "unknown";
  document_type?: DocumentType;
  source_institution?: string;
  known_layout_id?: string;
  image_quality?: ImageQuality;
  layout_complexity?: LayoutComplexity;
  has_tables?: boolean;
  table_count?: number;
  table_density?: number;
  has_handwriting?: boolean;
  language?: string;
  requires_reconciliation?: boolean;
  contains_financial_data?: boolean;
  target_schema?: string;
  prior_validation_failed?: boolean;
  confidence?: number;
}

export interface DocumentDifficulty {
  score: number;
  complexity: "low" | "medium" | "high";
  reasons: string[];
  recommendedTaskType: TaskType;
}

export interface RouteRequest {
  prompt: string;
  task_type?: TaskType;
  step_type?: string;
  trajectory_id?: string;
  agent_id?: string;
  estimated_input_tokens?: number;
  estimated_output_tokens?: number;
  document_profile?: DocumentProfile;
  policy?: RoutingPolicy;
}

export interface ModelScore {
  modelId: string;
  score: number;
  costScore: number;
  qualityScore: number;
  latencyScore: number;
  documentFitScore?: number;
  rawDocumentFitScore?: number;
  documentFitReasons?: string[];
  tierBonus?: number;
  staticScore?: number;
  learnedScore?: number;
  learnedBlend?: number;
  estimatedCostUsd: number;
  filteredReason?: string;
}

export interface RoutingDecision {
  requestId: string;
  timestamp: string;
  agentId?: string;
  trajectoryId?: string;
  stepType?: string;
  detectedTaskType: TaskType;
  classificationConfidence: number;
  selectedModel: ModelSpec;
  fallbackModel?: ModelSpec;
  policyApplied: RoutingPolicy;
  modelScores: ModelScore[];
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  estimatedLatencyMs: number;
  reasoning: string;
  alternativesConsidered: string[];
  documentProfile?: DocumentProfile;
  documentDifficulty?: DocumentDifficulty;
}

export interface TrajectoryState {
  trajectoryId: string;
  agentId?: string;
  startModel: string;
  currentModel: string;
  stepCount: number;
  totalCostUsd: number;
  budgetRemainingUsd?: number;
  stepHistory: Array<{
    step: number;
    stepType: string;
    modelId: string;
    costUsd: number;
    latencyMs: number;
  }>;
  startedAt: string;
  lastUpdatedAt: string;
}

export interface RouterOutcome {
  id: string;
  requestId: string;
  timestamp: string;
  trajectoryId?: string;
  agentId?: string;
  modelId: string;
  taskType: TaskType;
  success: boolean;
  validationPassed?: boolean;
  neededEscalation: boolean;
  qualityScore?: number;
  actualCostUsd?: number;
  actualLatencyMs?: number;
  errorType?: string;
  evaluatorType: "rule" | "llm_judge" | "human" | "test" | "validator";
  evaluatorModelId?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface ModelTaskScore {
  modelId: string;
  taskType: TaskType;
  sampleCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgQualityScore: number;
  avgCostUsd: number;
  avgLatencyMs: number;
  escalationRate: number;
  learnedScore: number;
  lastOutcomeAt?: string;
  updatedAt: string;
}

export interface OutcomeInput {
  request_id: string;
  success: boolean;
  validation_passed?: boolean;
  needed_escalation?: boolean;
  quality_score?: number;
  actual_cost_usd?: number;
  actual_latency_ms?: number;
  error_type?: string;
  evaluator_type?: RouterOutcome["evaluatorType"];
  evaluator_model_id?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface ExecuteRequest extends RouteRequest {
  system_prompt?: string;
  temperature?: number;
  max_output_tokens?: number;
  dry_run?: boolean;
  record_outcome?: boolean;
  provider_credentials?: Partial<Record<ModelProvider | "self_hosted", {
    apiKey?: string;
    baseUrl?: string;
  }>>;
}

export interface ProviderExecutionResult {
  provider: ModelProvider;
  modelId: string;
  outputText: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  actualCostUsd?: number;
  actualLatencyMs: number;
  dryRun: boolean;
  raw?: unknown;
}

export interface ExecuteResult {
  decision: RoutingDecision;
  execution: ProviderExecutionResult;
}

export interface V2LearningEvent {
  id: string;
  timestamp: string;
  userId?: string;
  sessionId: string;
  eventType:
    | "provider_configured"
    | "model_pool_saved"
    | "document_profiled"
    | "recommendation_created"
    | "model_selected"
    | "extraction_simulated"
    | "extraction_executed"
    | "eval_completed"
    | "feedback_happy"
    | "feedback_not_happy"
    | "escalated_next_model";
  requestId?: string;
  modelId?: string;
  taskType?: TaskType;
  documentProfile?: DocumentProfile;
  extractionInstruction?: string;
  payload?: Record<string, unknown>;
}

export interface DeterministicEvalResult {
  validationPassed: boolean;
  qualityScore: number;
  errors: string[];
  warnings: string[];
  checks: Array<{ name: string; passed: boolean; weight: number; detail: string }>;
}
