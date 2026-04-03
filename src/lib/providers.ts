export const PROVIDER_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  kilo: "https://api.kilo.ai/api/gateway/chat/completions",
  google:
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  cerebras: "https://api.cerebras.ai/v1/chat/completions",
  sambanova: "https://api.sambanova.ai/v1/chat/completions",
  mistral: "https://api.mistral.ai/v1/chat/completions",
};

export const PROVIDER_LABELS: Record<string, string> = {
  openrouter: "OR",
  kilo: "Kilo",
  google: "GG",
  groq: "Groq",
  cerebras: "Cerebras",
  sambanova: "SN",
  mistral: "Mistral",
};
