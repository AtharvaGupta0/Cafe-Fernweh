// Provider entry points kept explicit for clarity. Additional providers can
// be added here and wired into src/server/inference/adapter.ts without
// touching the orchestration layer.

export {
  createProvider,
  getInferenceConfigFromEnv,
  GENERATION_TEMPERATURE,
  GENERATION_MAX_OUTPUT_TOKENS,
  type InferenceConfig,
  type InferenceResult,
} from "./adapter";
