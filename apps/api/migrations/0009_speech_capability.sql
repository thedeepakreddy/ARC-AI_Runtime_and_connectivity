-- Phase 7 (multimodal, increment 1). Expand-only: the previous release never writes 'speech'.

-- Text-to-speech models (/v1/audio/speech) get their own capability, so a chat model that can
-- also answer with audio ('audio_output') is never picked to synthesise speech.
ALTER TABLE models DROP CONSTRAINT models_capabilities_check;
ALTER TABLE models ADD CONSTRAINT models_capabilities_check
  CHECK (capabilities <@ ARRAY['text', 'vision', 'audio_input', 'transcription', 'audio_output',
                               'speech', 'embeddings', 'video', 'documents', 'streaming',
                               'structured_output', 'tools']::text[]);
