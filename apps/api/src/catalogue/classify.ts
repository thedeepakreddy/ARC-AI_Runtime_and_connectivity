/**
 * Automatic model classification: what a provider's own model list says (OpenRouter publishes
 * prices, input/output kinds and supported parameters; Gemini publishes its methods), plus the
 * model's name. Used when a key is validated, only for models the owner hasn't classified by
 * hand; the owner can always change it, or go back to the automatic suggestion.
 */
import type { Capability } from '../inference/schemas.js';

/** What a provider's /models listing says about one model (fields are optional). */
export interface ModelHints {
  /** Price per token for prompt and completion, as the provider states it. */
  pricing?: { prompt?: string | number | null; completion?: string | number | null } | null;
  inputModalities?: string[] | null;
  outputModalities?: string[] | null;
  /** OpenAI-style parameters the model accepts (tools, response_format, …). */
  supportedParameters?: string[] | null;
  /** Gemini: generateContent, embedContent, … */
  methods?: string[] | null;
}

export type Eligibility = 'VERIFIED_FREE' | 'RESTRICTED_FREE' | 'PAID' | 'UNKNOWN';

export interface Suggestion {
  eligibility: Eligibility;
  /** Where the price came from (required by ARC for anything but UNKNOWN). */
  evidenceUrl: string | null;
  capabilities: Capability[];
  /** Turn it on straight away: only for models the provider itself says are free. */
  enable: boolean;
  /** One line on why, shown in the console. */
  reason: string;
  /** The provider's pricing page, to prefill the evidence when classifying by hand. */
  pricingPage: string | null;
}

const isZero = (v: unknown) => v !== undefined && v !== null && v !== '' && Number(v) === 0;
const isPositive = (v: unknown) => v !== undefined && v !== null && v !== '' && Number(v) > 0;

/** Capabilities from the model's name, for providers that publish nothing else. */
function fromName(id: string): Capability[] | null {
  const n = id.toLowerCase();
  if (/whisper|transcri|speech-to-text|\bstt\b/.test(n)) return ['transcription'];
  if (/\btts\b|-tts|text-to-speech|playai|orpheus/.test(n)) return ['speech'];
  if (/embed/.test(n)) return ['embeddings'];
  if (/dall-e|imagen|flux|stable-diffusion|sdxl|image-gen|gpt-image/.test(n)) {
    return ['image_generation'];
  }
  if (/guard|moderation|rerank/.test(n)) return [];
  const caps: Capability[] = ['text', 'streaming'];
  if (
    /vision|-vl\b|-vl-|llava|pixtral|gemini|gpt-4o|gpt-4\.1|gpt-5|claude|scout|maverick|gemma-3/.test(
      n,
    )
  ) {
    caps.push('vision');
  }
  if (
    /gemini|gpt-4|gpt-5|claude|llama-3\.[1-9]|llama-4|qwen|mistral|command|deepseek|kimi|glm/.test(
      n,
    )
  ) {
    caps.push('tools', 'structured_output');
  }
  if (/gemini/.test(n) && !/embed|imagen|tts/.test(n)) caps.push('audio_input', 'documents');
  return caps;
}

/** Marker: a model that can't chat; its name decides the rest (see suggestClassification). */
const NON_CHAT: Capability[] = [];
const CHAT_CAPS = new Set<Capability>([
  'text',
  'streaming',
  'tools',
  'structured_output',
  'vision',
  'audio_input',
  'documents',
]);

/** Capabilities from what the provider says the model accepts and produces. */
function fromHints(h: ModelHints): Capability[] | null {
  if (h.methods?.length) {
    if (h.methods.includes('embedContent') && !h.methods.includes('generateContent')) {
      return ['embeddings'];
    }
    // Not a chat model (Imagen, Veo, TTS, Interactions-only…): only what its name says it
    // makes, never text or tools.
    if (!h.methods.includes('generateContent')) return NON_CHAT;
  }
  const input = h.inputModalities?.map((m) => m.toLowerCase());
  const output = h.outputModalities?.map((m) => m.toLowerCase());
  const params = h.supportedParameters;
  if (!input && !output && !params) return null;
  const caps = new Set<Capability>();
  if (!output || output.includes('text')) caps.add('text').add('streaming');
  if (output?.includes('image')) caps.add('image_generation');
  if (output?.includes('audio')) caps.add('audio_output');
  if (input?.includes('image')) caps.add('vision');
  if (input?.includes('audio')) caps.add('audio_input');
  if (input?.includes('file')) caps.add('documents');
  if (input?.includes('video')) caps.add('video');
  if (params?.includes('tools')) caps.add('tools');
  if (params?.some((p) => p === 'response_format' || p === 'structured_outputs')) {
    caps.add('structured_output');
  }
  return [...caps];
}

/** Each provider's page that states its prices or free tier. */
const PRICING_PAGES: Record<string, string> = {
  gemini: 'https://ai.google.dev/gemini-api/docs/pricing',
  groq: 'https://console.groq.com/docs/rate-limits',
  mistral: 'https://mistral.ai/pricing',
  cerebras: 'https://inference-docs.cerebras.ai/support/rate-limits',
  cloudflare: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
  github: 'https://docs.github.com/en/github-models/use-github-models/prototyping-with-ai-models',
};
export const pricingPage = (providerId: string, modelId: string): string | null =>
  providerId === 'openrouter'
    ? `https://openrouter.ai/${modelId}`
    : (PRICING_PAGES[providerId] ?? null);

export function suggestClassification(
  providerId: string,
  modelId: string,
  hints: ModelHints = {},
): Suggestion {
  const hinted = fromHints(hints);
  const capabilities =
    hinted === NON_CHAT
      ? (fromName(modelId) ?? []).filter((c) => !CHAT_CAPS.has(c))
      : (hinted ?? fromName(modelId) ?? ['text', 'streaming']);
  const p = hints.pricing;
  const free = !!p && isZero(p.prompt) && isZero(p.completion);
  const paid = !!p && (isPositive(p.prompt) || isPositive(p.completion));
  const evidenceUrl = pricingPage(providerId, modelId);
  const page = evidenceUrl;

  if (free && evidenceUrl) {
    return {
      eligibility: 'VERIFIED_FREE',
      evidenceUrl,
      capabilities,
      enable: capabilities.length > 0,
      reason: `${providerId === 'openrouter' ? 'OpenRouter' : 'The provider'} lists it at no cost.`,
      pricingPage: page,
    };
  }
  if (paid && evidenceUrl) {
    return {
      eligibility: 'PAID',
      evidenceUrl,
      capabilities,
      enable: false,
      reason: 'The provider lists a price per token.',
      pricingPage: page,
    };
  }
  return {
    eligibility: 'UNKNOWN',
    evidenceUrl: null,
    capabilities,
    enable: false,
    reason: evidenceUrl
      ? 'Free or paid depends on your plan: check the pricing page and classify it.'
      : 'The provider publishes no price here: check it and classify it.',
    pricingPage: page,
  };
}
