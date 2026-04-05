export const PROVIDER_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  kilo: "https://api.kilo.ai/api/gateway/chat/completions",
  google:
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  cerebras: "https://api.cerebras.ai/v1/chat/completions",
  sambanova: "https://api.sambanova.ai/v1/chat/completions",
  mistral: "https://api.mistral.ai/v1/chat/completions",
  ollama: `${process.env.OLLAMA_BASE_URL || "http://localhost:11434"}/v1/chat/completions`,
  github: "https://models.github.ai/inference/chat/completions",
  fireworks: "https://api.fireworks.ai/inference/v1/chat/completions",
  cohere: "https://api.cohere.com/v2/chat/completions",
  cloudflare: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID || ""}/ai/v1/chat/completions`,
};

// Embedding endpoints (providers that support embeddings)
export const PROVIDER_EMBEDDING_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1/embeddings",
  mistral: "https://api.mistral.ai/v1/embeddings",
  ollama: `${process.env.OLLAMA_BASE_URL || "http://localhost:11434"}/v1/embeddings`,
};

// Legacy completions endpoints (providers that support /v1/completions)
export const PROVIDER_COMPLETIONS_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1/completions",
  groq: "https://api.groq.com/openai/v1/completions",
  ollama: `${process.env.OLLAMA_BASE_URL || "http://localhost:11434"}/v1/completions`,
};

export const PROVIDER_LABELS: Record<string, string> = {
  openrouter: "OR",
  kilo: "Kilo",
  google: "GG",
  groq: "Groq",
  cerebras: "Cerebras",
  sambanova: "SN",
  mistral: "Mistral",
  ollama: "Local",
  github: "GitHub",
  fireworks: "FW",
  cohere: "Cohere",
  cloudflare: "CF",
};
