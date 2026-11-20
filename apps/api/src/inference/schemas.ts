import { z } from 'zod';

/**
 * OpenAI-compatible request bodies. Only allow-listed fields are forwarded to the gateway, so a
 * client can never inject routing or credential fields (api_key, api_base, base_url, ...).
 */
const CHAT_PASSTHROUGH = [
  'messages',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'n',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'seed',
  'user',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'response_format',
  'stream_options',
  'reasoning_effort',
  'modalities',
  'audio',
] as const;

const EMBEDDING_PASSTHROUGH = ['input', 'encoding_format', 'dimensions', 'user'] as const;

const messageSchema = z
  .object({
    role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
    content: z
      .union([z.string(), z.array(z.looseObject({ type: z.string() })), z.null()])
      .optional(),
  })
  .loose();

export const chatRequestSchema = z
  .object({
    model: z.string().min(1).max(320),
    messages: z.array(messageSchema).min(1).max(2000),
    stream: z.boolean().optional(),
    tools: z.array(z.looseObject({})).max(256).optional(),
    response_format: z.looseObject({ type: z.string() }).optional(),
  })
  .loose();

export const embeddingRequestSchema = z
  .object({
    model: z.string().min(1).max(320),
    input: z.union([
      z.string().min(1),
      z.array(z.string()).min(1).max(2048),
      z.array(z.number()).min(1),
      z.array(z.array(z.number())).min(1).max(2048),
    ]),
  })
  .loose();

/**
 * Text to speech (/v1/audio/speech). OpenAI's fields; the voice names a provider's voice, and
 * the response is audio in `response_format`.
 */
export const speechRequestSchema = z
  .object({
    model: z.string().min(1).max(320),
    input: z.string().min(1).max(4096),
    voice: z.string().min(1).max(100),
    response_format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).optional(),
    speed: z.number().min(0.25).max(4).optional(),
    instructions: z.string().max(4096).optional(),
  })
  .loose();
const SPEECH_PASSTHROUGH = ['input', 'voice', 'response_format', 'speed', 'instructions'] as const;

/**
 * Speech to text (/v1/audio/transcriptions), sent as multipart form fields next to the audio
 * file. Only these fields are forwarded.
 */
export const transcriptionFieldsSchema = z.object({
  model: z.string().min(1).max(320),
  language: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/)
    .optional(),
  prompt: z.string().max(4096).optional(),
  response_format: z.enum(['json', 'text', 'srt', 'verbose_json', 'vtt']).optional(),
  temperature: z.coerce.number().min(0).max(1).optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type SpeechRequest = z.infer<typeof speechRequestSchema>;
export type TranscriptionFields = z.infer<typeof transcriptionFieldsSchema>;
export type EmbeddingRequest = z.infer<typeof embeddingRequestSchema>;

function pick(body: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

export const chatPassthrough = (body: ChatRequest) => pick(body, CHAT_PASSTHROUGH);
export const embeddingPassthrough = (body: EmbeddingRequest) => pick(body, EMBEDDING_PASSTHROUGH);
export const speechPassthrough = (body: SpeechRequest) => pick(body, SPEECH_PASSTHROUGH);
/** Form fields for the provider, as strings (the model is ARC's choice, added later). */
export const transcriptionPassthrough = (f: TranscriptionFields): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const k of ['language', 'prompt', 'response_format', 'temperature'] as const) {
    if (f[k] !== undefined) out[k] = String(f[k]);
  }
  return out;
};

export type Capability =
  | 'text'
  | 'vision'
  | 'audio_input'
  | 'transcription'
  | 'audio_output'
  | 'speech'
  | 'embeddings'
  | 'video'
  | 'documents'
  | 'streaming'
  | 'structured_output'
  | 'tools';

/** Capabilities a chat request needs, derived cheaply from its shape (no model call). */
export function requiredChatCapabilities(body: ChatRequest): Set<Capability> {
  const need = new Set<Capability>(['text']);
  if (body.stream) need.add('streaming');
  if (body.tools?.length) need.add('tools');
  if (body.response_format && body.response_format.type !== 'text') need.add('structured_output');
  if (Array.isArray(body.modalities) && body.modalities.includes('audio')) need.add('audio_output');
  for (const m of body.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part.type === 'image_url' || part.type === 'image') need.add('vision');
      else if (part.type === 'input_audio') need.add('audio_input');
      else if (part.type === 'file') need.add('documents');
      else if (part.type === 'video_url') need.add('video');
    }
  }
  return need;
}
