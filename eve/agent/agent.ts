import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { defineAgent } from 'eve';

// Anthropic models served through Google Vertex AI. The community
// `anthropic-vertex-ai` package targets the AI SDK v1 model spec and zod 3,
// which eve (ai 7, zod 4) cannot load, so this uses the AI SDK's own
// Anthropic-on-Vertex provider instead — same models, same authentication
// (Google application default credentials).
const anthropicVertex = createVertexAnthropic({
  project: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
  location: process.env.ANTHROPIC_VERTEX_LOCATION ?? 'global',
});

export default defineAgent({
  model: anthropicVertex('claude-opus-4-6'),
  // Direct provider models carry no AI Gateway metadata, so the context
  // window must be stated for eve's compaction trigger. Conservative bound;
  // Claude Opus 4.6 supports up to 1M tokens.
  modelContextWindowTokens: 200_000,
});
