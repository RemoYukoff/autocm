# TODO

## Agents pick the ElevenLabs model for what they are making

Today the models are fixed in code (`src/agents/assets.ts`): four image models in an enum, and video is always
Veo 3.1 Fast (`CLIP_MODEL`). The designer and the editor should instead choose any model the ElevenLabs workspace
can run, based on what the shot or picture needs (e.g. Kling 3.0 Pro for a 15 s multi-shot clip, Veo 3.1 for spoken
dialogue, FLUX 3 for rendered text, Seedream 5 Pro for product-shot realism, Nano Banana Pro to keep a character
consistent).

- List the models at runtime with `creative_get_flow_node_types` (image-generation, video-generation, music) and
  cache it per day, instead of a hardcoded list. Give the agent each model's one-line strengths.
- Let the agent read `creative_get_model_guide` for a model before prompting it.
- Parameters differ per model (durations, aspect ratios, resolution, audio): validate the agent's params against
  `creative_get_model_schema` in the runner (`src/media/elevenlabs.ts`) instead of the fixed params passed today.
- Price every generation first (`estimate_only`) and show the cost to the agent, so it weighs it against the gain.
  Keep the per-post caps, and add a monthly credit budget guard (the Creator plan has 131k credits a month).
- Image-to-video: let the editor feed a generated or designed still as `start_frame` / `reference_images`
  (needs the asset upload flow: `creative_create_asset_upload` -> PUT -> `creative_finalize_asset_upload`).
- Leave out the editing, lipsync and avatar models until a post needs them.
