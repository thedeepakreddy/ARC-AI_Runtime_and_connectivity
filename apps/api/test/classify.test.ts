import { describe, expect, it } from 'vitest';
import { modelClass, suggestClassification } from '../src/catalogue/classify.js';

describe('automatic model classification', () => {
  it('OpenRouter free models: verified free, from the listing, turned on', () => {
    const s = suggestClassification('openrouter', 'meta-llama/llama-4-scout:free', {
      pricing: { prompt: '0', completion: '0' },
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      supportedParameters: ['tools', 'structured_outputs', 'max_tokens'],
    });
    expect(s).toMatchObject({
      eligibility: 'VERIFIED_FREE',
      evidenceUrl: 'https://openrouter.ai/meta-llama/llama-4-scout:free',
      enable: true,
    });
    expect(s.capabilities.sort()).toEqual(
      ['streaming', 'structured_output', 'text', 'tools', 'vision'].sort(),
    );
  });

  it('priced models are paid and stay off', () => {
    const s = suggestClassification('openrouter', 'openai/gpt-5', {
      pricing: { prompt: '0.000002', completion: '0.00001' },
    });
    expect(s).toMatchObject({ eligibility: 'PAID', enable: false });
  });

  it('without a price, nothing is assumed: not checked, off, with capabilities from the name', () => {
    const whisper = suggestClassification('groq', 'whisper-large-v3-turbo');
    expect(whisper).toMatchObject({ eligibility: 'UNKNOWN', enable: false, evidenceUrl: null });
    expect(whisper.capabilities).toEqual(['transcription']);
    expect(suggestClassification('groq', 'playai-tts').capabilities).toEqual(['speech']);
    expect(
      suggestClassification('gemini', 'gemini-embedding-001', { methods: ['embedContent'] })
        .capabilities,
    ).toEqual(['embeddings']);
    const flash = suggestClassification('gemini', 'gemini-3.8-flash', {
      methods: ['generateContent'],
    });
    expect(flash.capabilities).toEqual(expect.arrayContaining(['text', 'vision', 'tools']));
    expect(flash.eligibility).toBe('UNKNOWN');
  });

  it('Gemini models that cannot chat get no chat abilities', () => {
    expect(
      suggestClassification('gemini', 'antigravity-preview-09-2026', {
        methods: ['createInteraction'],
      }).capabilities,
    ).toEqual([]);
    expect(
      suggestClassification('gemini', 'imagen-4.0-generate-001', { methods: ['predict'] })
        .capabilities,
    ).toEqual(['image_generation']);
    expect(
      suggestClassification('gemini', 'gemini-2.5-flash-preview-tts', { methods: ['countTokens'] })
        .capabilities,
    ).toEqual(['speech']);
    expect(
      suggestClassification('gemini', 'veo-3.0-generate-001', { methods: ['predictLongRunning'] })
        .capabilities,
    ).toEqual([]);
  });

  it('language-specific free models are classified but left off, with a note', () => {
    const s = suggestClassification('openrouter', 'sdaia/allam-2-7b:free', {
      pricing: { prompt: '0', completion: '0' },
    });
    expect(s).toMatchObject({ eligibility: 'VERIFIED_FREE', enable: false });
    expect(s.reason).toMatch(/one language/);
  });

  it('model classes: general, small, then language-specific or narrow', () => {
    expect(modelClass('llama-3.3-70b-versatile')).toBe(0);
    expect(modelClass('llama-3.1-8b-instant')).toBe(0);
    expect(modelClass('gemini-2.5-flash-lite')).toBe(0);
    expect(modelClass('meta-llama/llama-4-scout-17b-16e-instruct')).toBe(0);
    expect(modelClass('gemma-3-4b-it')).toBe(1);
    expect(modelClass('qwen3-0.6b')).toBe(1);
    expect(modelClass('gpt-4o-mini')).toBe(1);
    expect(modelClass('allam-2-7b')).toBe(2);
    expect(modelClass('meta-llama/llama-guard-4-12b')).toBe(2);
  });
});
