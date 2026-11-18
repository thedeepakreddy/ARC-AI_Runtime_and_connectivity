import type { Queryable } from '../db/pool.js';

export type ProviderGroup = 'core' | 'international' | 'chinese' | 'local' | 'speech_embeddings';
export type Jurisdiction = 'US' | 'EU' | 'UK' | 'CA' | 'CN' | 'SELF_HOSTED';
export type Adapter = 'litellm_native' | 'openai_compatible';

export interface ProviderDef {
  id: string;
  displayName: string;
  group: ProviderGroup;
  jurisdiction: Jurisdiction;
  adapter: Adapter;
  /** LiteLLM provider prefix, where LiteLLM has native support. */
  litellmProvider: string | null;
  /** Default API base. Null when each key must supply its own (e.g. account-scoped URLs). */
  defaultBaseUrl: string | null;
}

/**
 * Provider catalogue (see docs/providers.md).
 *
 * UNVERIFIED: base URLs, LiteLLM prefixes and adapters are working assumptions. Each provider
 * must be checked against its official docs (and `verified_at` set) in its provider-pack PR
 * before any of its models can be enabled. Free-tier status lives on models, not here.
 */
export const PROVIDERS: readonly ProviderDef[] = [
  // Core (original blueprint)
  {
    id: 'gemini',
    displayName: 'Google Gemini',
    group: 'core',
    jurisdiction: 'US',
    adapter: 'litellm_native',
    litellmProvider: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
  {
    id: 'groq',
    displayName: 'Groq',
    group: 'core',
    jurisdiction: 'US',
    adapter: 'openai_compatible',
    litellmProvider: 'groq',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    group: 'core',
    jurisdiction: 'US',
    adapter: 'openai_compatible',
    litellmProvider: 'openrouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    id: 'cloudflare',
    displayName: 'Cloudflare Workers AI',
    group: 'core',
    jurisdiction: 'US',
    adapter: 'openai_compatible',
    litellmProvider: 'cloudflare',
    defaultBaseUrl: null,
  },
  {
    id: 'mistral',
    displayName: 'Mistral',
    group: 'core',
    jurisdiction: 'EU',
    adapter: 'openai_compatible',
    litellmProvider: 'mistral',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    group: 'core',
    jurisdiction: 'SELF_HOSTED',
    adapter: 'openai_compatible',
    litellmProvider: 'ollama',
    defaultBaseUrl: null,
  },

  // International
  {
    id: 'cerebras',
    displayName: 'Cerebras',
    group: 'international',
    jurisdiction: 'US',
    adapter: 'openai_compatible',
    litellmProvider: 'cerebras',
    defaultBaseUrl: 'https://api.cerebras.ai/v1',
  },
  {
    id: 'sambanova',
    displayName: 'SambaNova Cloud',
    group: 'international',
    jurisdiction: 'US',
    adapter: 'openai_compatible',
    litellmProvider: 'sambanova',
    defaultBaseUrl: 'https://api.sambanova.ai/v1',
  },
  {
    id: 'github-models',
    displayName: 'GitHub Models',
    group: 'international',
    jurisdiction: 'US',
    adapter: 'openai_compatible',
    litellmProvider: 'github',
    defaultBaseUrl: null,
  },
  {
    id: 'huggingface',
    displayName: 'Hugging Face Inference Providers',
    group: 'international',
    jurisdiction: 'US',
    adapter: 'openai_compatible',
    litellmProvider: 'huggingface',
    defaultBaseUrl: null,
  },
  {
    id: 'nvidia-nim',
    displayName: 'NVIDIA NIM',
    group: 'international',
    jurisdiction: 'US',
    adapter: 'openai_compatible',
    litellmProvider: 'nvidia_nim',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
  },
  {
    id: 'cohere',
    displayName: 'Cohere',
    group: 'international',
    jurisdiction: 'CA',
    adapter: 'litellm_native',
    litellmProvider: 'cohere',
    defaultBaseUrl: null,
  },
  {
    id: 'together',
    displayName: 'Together AI',
    group: 'international',
    jurisdiction: 'US',
    adapter: 'openai_compatible',
    litellmProvider: 'together_ai',
    defaultBaseUrl: 'https://api.together.xyz/v1',
  },
  {
    id: 'fireworks',
    displayName: 'Fireworks',
    group: 'international',
    jurisdiction: 'US',
    adapter: 'openai_compatible',
    litellmProvider: 'fireworks_ai',
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
  },
  {
    id: 'nebius',
    displayName: 'Nebius',
    group: 'international',
    jurisdiction: 'EU',
    adapter: 'openai_compatible',
    litellmProvider: 'nebius',
    defaultBaseUrl: null,
  },
  {
    id: 'deepinfra',
    displayName: 'DeepInfra',
    group: 'international',
    jurisdiction: 'US',
    adapter: 'openai_compatible',
    litellmProvider: 'deepinfra',
    defaultBaseUrl: 'https://api.deepinfra.com/v1/openai',
  },

  // Chinese
  {
    id: 'alibaba-dashscope',
    displayName: 'Alibaba Cloud Model Studio (Qwen)',
    group: 'chinese',
    jurisdiction: 'CN',
    adapter: 'openai_compatible',
    litellmProvider: 'dashscope',
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  },
  {
    id: 'modelscope',
    displayName: 'ModelScope',
    group: 'chinese',
    jurisdiction: 'CN',
    adapter: 'openai_compatible',
    litellmProvider: null,
    defaultBaseUrl: null,
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    group: 'chinese',
    jurisdiction: 'CN',
    adapter: 'openai_compatible',
    litellmProvider: 'deepseek',
    defaultBaseUrl: 'https://api.deepseek.com',
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot AI (Kimi)',
    group: 'chinese',
    jurisdiction: 'CN',
    adapter: 'openai_compatible',
    litellmProvider: 'moonshot',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
  },
  {
    id: 'zhipu',
    displayName: 'Zhipu AI / Z.ai (GLM)',
    group: 'chinese',
    jurisdiction: 'CN',
    adapter: 'openai_compatible',
    litellmProvider: null,
    defaultBaseUrl: null,
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    group: 'chinese',
    jurisdiction: 'CN',
    adapter: 'openai_compatible',
    litellmProvider: null,
    defaultBaseUrl: null,
  },
  {
    id: 'baidu-qianfan',
    displayName: 'Baidu Qianfan (ERNIE)',
    group: 'chinese',
    jurisdiction: 'CN',
    adapter: 'openai_compatible',
    litellmProvider: null,
    defaultBaseUrl: null,
  },
  {
    id: 'tencent-hunyuan',
    displayName: 'Tencent Hunyuan',
    group: 'chinese',
    jurisdiction: 'CN',
    adapter: 'openai_compatible',
    litellmProvider: null,
    defaultBaseUrl: null,
  },
  {
    id: 'volcengine-ark',
    displayName: 'ByteDance Volcengine Ark (Doubao)',
    group: 'chinese',
    jurisdiction: 'CN',
    adapter: 'openai_compatible',
    litellmProvider: 'volcengine',
    defaultBaseUrl: null,
  },
  {
    id: 'iflytek-spark',
    displayName: 'iFlytek Spark',
    group: 'chinese',
    jurisdiction: 'CN',
    adapter: 'openai_compatible',
    litellmProvider: null,
    defaultBaseUrl: null,
  },
  {
    id: 'stepfun',
    displayName: 'StepFun',
    group: 'chinese',
    jurisdiction: 'CN',
    adapter: 'openai_compatible',
    litellmProvider: null,
    defaultBaseUrl: null,
  },
  {
    id: 'siliconflow',
    displayName: 'SiliconFlow',
    group: 'chinese',
    jurisdiction: 'CN',
    adapter: 'openai_compatible',
    litellmProvider: null,
    defaultBaseUrl: null,
  },

  // Local / self-hosted (each key supplies its own base URL)
  {
    id: 'lm-studio',
    displayName: 'LM Studio',
    group: 'local',
    jurisdiction: 'SELF_HOSTED',
    adapter: 'openai_compatible',
    litellmProvider: 'lm_studio',
    defaultBaseUrl: null,
  },
  {
    id: 'vllm',
    displayName: 'vLLM',
    group: 'local',
    jurisdiction: 'SELF_HOSTED',
    adapter: 'openai_compatible',
    litellmProvider: 'hosted_vllm',
    defaultBaseUrl: null,
  },
  {
    id: 'llama-cpp',
    displayName: 'llama.cpp server',
    group: 'local',
    jurisdiction: 'SELF_HOSTED',
    adapter: 'openai_compatible',
    litellmProvider: null,
    defaultBaseUrl: null,
  },

  // Speech and embeddings
  {
    id: 'deepgram',
    displayName: 'Deepgram',
    group: 'speech_embeddings',
    jurisdiction: 'US',
    adapter: 'litellm_native',
    litellmProvider: 'deepgram',
    defaultBaseUrl: null,
  },
  {
    id: 'assemblyai',
    displayName: 'AssemblyAI',
    group: 'speech_embeddings',
    jurisdiction: 'US',
    adapter: 'litellm_native',
    litellmProvider: null,
    defaultBaseUrl: null,
  },
  {
    id: 'elevenlabs',
    displayName: 'ElevenLabs',
    group: 'speech_embeddings',
    jurisdiction: 'US',
    adapter: 'litellm_native',
    litellmProvider: null,
    defaultBaseUrl: null,
  },
  {
    id: 'jina',
    displayName: 'Jina AI',
    group: 'speech_embeddings',
    jurisdiction: 'EU',
    adapter: 'litellm_native',
    litellmProvider: 'jina_ai',
    defaultBaseUrl: null,
  },
  {
    id: 'voyage',
    displayName: 'Voyage AI',
    group: 'speech_embeddings',
    jurisdiction: 'US',
    adapter: 'litellm_native',
    litellmProvider: 'voyage',
    defaultBaseUrl: null,
  },
];

/** Upsert the catalogue. Never clears `verified_at` set by an operator. */
export async function syncProviderCatalogue(q: Queryable): Promise<void> {
  for (const p of PROVIDERS) {
    await q.query(
      `INSERT INTO providers (id, display_name, provider_group, jurisdiction, adapter,
                              litellm_provider, default_base_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name, provider_group = EXCLUDED.provider_group,
         jurisdiction = EXCLUDED.jurisdiction, adapter = EXCLUDED.adapter,
         litellm_provider = EXCLUDED.litellm_provider,
         default_base_url = EXCLUDED.default_base_url, updated_at = now()`,
      [
        p.id,
        p.displayName,
        p.group,
        p.jurisdiction,
        p.adapter,
        p.litellmProvider,
        p.defaultBaseUrl,
      ],
    );
  }
}
