// Provider entry points kept explicit for clarity. Additional providers can
// be added here and wired into src/server/inference/adapter.ts without
// touching the orchestration layer.

export { createProvider, getInferenceConfigFromEnv, type InferenceConfig, type InferenceResult } from "./adapter";
