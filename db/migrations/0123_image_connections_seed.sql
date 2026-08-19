-- Exposes a fixed generation seed on image_connections (Connections tab, io/imageConnections.ts).
-- Every image provider adapter already accepts/forwards a numeric seed (io/imageGen/*.ts) but
-- Portrait Studio's two render call sites (orchestrator/portraitGeneration.ts) have always sent
-- seed: null — candidate variety was meant to come from the mutated prompt text, not the diffusion
-- seed. This column lets an admin pin a seed per connection instead; left null (the default), the
-- provider keeps choosing its own random seed exactly as today, so nothing changes for a connection
-- that never sets it.
--
-- bigint, same type as locations.seed (migration 0045) — that's an unrelated, already-solved
-- mechanism (a fixed shared seed baked into synthesizeImagePrompt.ts for pixel-identical location
-- re-renders) and this column does not touch it; portraitGeneration.ts's call sites are the only
-- ones reading image_connections.seed.

alter table image_connections add column seed bigint;
