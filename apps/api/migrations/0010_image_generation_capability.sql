-- Phase 7 (multimodal, increment 2). Expand-only: the previous release never writes
-- 'image_generation'.

-- Image models (/v1/images/generations) get their own capability: 'vision' means a model reads
-- images, not that it draws them.
ALTER TABLE models DROP CONSTRAINT models_capabilities_check;
ALTER TABLE models ADD CONSTRAINT models_capabilities_check
  CHECK (capabilities <@ ARRAY['text', 'vision', 'audio_input', 'transcription', 'audio_output',
                               'speech', 'image_generation', 'embeddings', 'video', 'documents',
                               'streaming', 'structured_output', 'tools']::text[]);
