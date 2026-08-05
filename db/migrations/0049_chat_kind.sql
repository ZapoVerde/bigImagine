-- RP chats as a first-class sibling to regular chat (docs/bi_principles.md §4, §16): household
-- memory and full tool access make sense for a general assistant chat but actively pollute a
-- roleplay, so `kind` splits chat_sessions into 'chat' | 'rp' at creation time. Set once, never
-- patched afterward — there is deliberately no "convert an existing chat to RP" path, since that
-- would make the memory-isolation guarantee (httpServer.ts's buildChatMemorySystemPrompt and the
-- archive route, both gated on kind) ambiguous for anything created before the conversion.
--
-- character_id records which character a chat is playing, set by applyCharacterToChatTool.ts
-- whenever it runs (both the pre-existing "Start chat with this character" flow and the new
-- "Start RP" flow) — this lets apply_prompt_stack_to_chat pull that character's fields into the
-- stack later without the caller re-passing characterId.
--
-- prompt_stack_preset_id records the last-applied stack so the settings panel can show the chat's
-- current selection on reload.
alter table chat_sessions add column kind text not null default 'chat' check (kind in ('chat', 'rp'));
alter table chat_sessions add column character_id uuid references characters(character_id) on delete set null;
alter table chat_sessions add column prompt_stack_preset_id uuid references context_stack_presets(preset_id) on delete set null;
