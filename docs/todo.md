# TODO

*Open items, tracked in docs. Nothing here is committed to a plan yet; each line will become its own plan (or repair) doc when picked up.*

1. **Exclude the cleanup pass from blocking editing or sending.** The in-stream/live cleanup work must never gate an edit (`truncateMessagesFrom`) or a new send — currently a pending repair on a message can hold things up. Cleanup should only ever follow up on text already shown, never withhold editing or sending.

2. **Add delete to the RP cast.** The RP sidebar's Cast section (`CastSection.tsx`) can list and indicate presence but cannot remove — add a delete affordance so a character can be dropped from the chat's cast (and decide what that cascades to: the `character_chat_link`, the `characters` row, or both).

3. **Roll content above the sync point out of the RP chat window.** Messages that have been consumed by the sync pipeline (archived past the live window / sync boundary, per `chat-memory.md`) should roll out of the RP chat window instead of continuing to render in full — surfaced as a boundary marker (and whatever replaces the rolled text) rather than the raw transcript.

