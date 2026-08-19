-- Portrait Studio: lesson maturity is internal until there is a real promotion workflow.
-- Existing and future Wiki entries should read as normal lessons, not permanently provisional
-- drafts. The visual_lessons.state column remains unchanged for future evidence/approval work.

update visual_wiki_entries
set title = regexp_replace(title, '^Provisional lesson:[[:space:]]*', ''),
    tags = array_remove(array_remove(tags, 'provisional'), null::text),
    updated_at = now()
where title like 'Provisional lesson:%'
   or 'provisional' = any(tags);
