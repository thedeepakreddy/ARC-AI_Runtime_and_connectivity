import { describe, expect, it } from 'vitest';
import { suggestClassification } from '../src/catalogue/classify.js';

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
});
