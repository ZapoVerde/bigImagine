# Location Lifecycle: The 4-Status Model

**Status**: Built, verified 2026-08-11 — cited by `chatSessions.ts` and `chatMemorySync.ts` §2.5
as the resurrection/status-transition design. Kept in its original informal, unedited form (an
unpolished chat excerpt, unlike its siblings' formal spec structure) — content is accurate and
actively cited; a formatting cleanup pass is optional, not urgent.

**Yes, absolutely. This is a much better narrative model, and it aligns even more deeply with BigImagine’s core principles.**

By keeping non-active swipe locations alive as **`inactive`** rather than purging them, we preserve **full timeline provenance**. Nothing is destroyed unless you explicitly delete the originating turn itself. If you fork 40 turns back onto an old swipe, every location (and item/fact) created during that alternate swipe is still sitting in the database, ready to wake up and solidify on the new branch.

Here is how the 4-status lifecycle works, how context exclusion is enforced, and how a dormant location re-activates upon forking.

---

### 1. The 4 Location Statuses

Instead of deleting unused locations at sync time, we transition them through 4 distinct states:

| Status | What it means | Injected into Prompt / RAG? | Can be promoted to Permanent? |
| :--- | :--- | :--- | :--- |
| **`transient`** | Created during an active turn in the live context buffer. | **Yes** (if tied to the active swipe). | Yes (when turn exits live window). |
| **`permanent`** | Promoted to canon. Unanchored from swipes. Part of world lore. | **Yes** (recalled via RAG or active scene). | N/A (already permanent). |
| **`inactive`** | Tied to a non-active swipe or alternate timeline branch. | **No** (excluded from active context). | **Yes** (if you fork or switch back to its swipe). |
| **`deleted`** | Originating message/swipe was explicitly deleted. | **No** (purged from DB via `CASCADE`). | No. |

---

### 2. How Context Exclusion Works (Preventing Timeline Pollution)

To prevent a location created in an inactive Swipe B ("Dark Cave") from leaking into Swipe A ("Forest Clearing"), **context assembly and RAG recall must filter by active timeline eligibility**.

When `assemblePromptStack` or `recall_canon_facts` runs:
A location is **eligible for context** if and only if:
1. `status = 'permanent'` (it's established world canon), **OR**
2. `status = 'transient'` **AND** its `anchor_swipe_id` matches a swipe currently on the **active swipe path** of this chat.

Because an inactive swipe ID is not in the current active path, its associated location is automatically ignored during prompt assembly. It hangs out silently in the database without polluting the story.

---

### 3. The Complete Lifecycle: From Creation to 40-Turn Fork

Let me walk through the exact database state at each step.

#### Step 1: Turn 5 (Generating 2 Swiping Variants)
* **Swipe 1 (Active)**: Creates Location 1 ("Forest Clearing").
  * Location 1: `status = 'transient'`, `anchor_swipe_id = swipe_1_id`.
* **Rerun / Swipe 2 (Inactive)**: Creates Location 2 ("Dark Cave").
  * Location 2: `status = 'transient'`, `anchor_swipe_id = swipe_2_id`.
* **Context**: Only Location 1 is active in `scenes.active_location_id` and prompt assembly.

#### Step 2: Turn 5 Exits Live Context Window (Sync Tick)
When Turn 5 passes into history (e.g. 10 turns later), `chatMemorySync.ts` evaluates Turn 5:
* **Active Swipe (Swipe 1)**: Location 1 is promoted -> `status = 'permanent'`, `anchor_swipe_id = NULL`.
* **Inactive Swipe (Swipe 2)**: Location 2 is marked dormant -> `status = 'inactive'`. (It is **NOT** deleted!).

```sql
-- Sync tick logic:
-- 1. Promote active swipe's locations:
UPDATE locations SET status = 'permanent', anchor_swipe_id = NULL
WHERE status = 'transient' AND anchor_swipe_id = $active_swipe_id;

-- 2. Mark inactive swipes' locations as dormant (instead of deleting them):
UPDATE locations SET status = 'inactive'
WHERE status = 'transient' AND anchor_swipe_id IN (
  SELECT swipe_id FROM chat_message_swipes 
  WHERE message_id = $synced_message_id AND swipe_id != $active_swipe_id
);
```

#### Step 3: Forking 40 Turns Later from Turn 5, Swipe 2
40 turns later, you open the **Branch Map**, navigate back to Turn 5, select **Swipe 2 ("Dark Cave")**, and click **Fork from here**.

1. `forkChat()` creates **Chat Branch B**.
2. It copies messages up to Turn 5, setting Turn 5's active content on *Branch B* to **Swipe 2**.
3. *Branch B* looks for any `inactive` or `transient` locations anchored to Swipe 2.
4. It finds **Location 2 ("Dark Cave")**!
5. Location 2 is cloned into *Branch B* with `status = 'transient'`, anchored to *Branch B*'s new Swipe 2.
6. As *Branch B* progresses and Turn 5 exits *Branch B*'s live context buffer, *Branch B*'s sync tick promotes Location 2 ("Dark Cave") to **`permanent`** on *Branch B*!

#### Step 4: Deleting Turn 5 (Hard Delete)
If at any point you click **Delete** on Turn 5 itself:
1. `DELETE FROM chat_messages WHERE message_id = turn_5_id`.
2. Postgres `ON DELETE CASCADE` deletes `swipe_1_id` and `swipe_2_id`.
3. Postgres `ON DELETE CASCADE` deletes **Location 1 and Location 2**.
4. Both locations are purged because the originating turn itself was destroyed.

---

### Why This Fits BigImagine’s Core Principles Perfectly

1. **Principle 1 (The Relational Store is Canonical)**: Every alternate timeline branch retains its true, uncorrupted history and artifacts in the relational database.
2. **Principle 3 (Explicit User Signal Outranks Inferred Signal)**: Deleting a turn is an explicit instruction to destroy that timeline's artifacts. Swiping or forking is an instruction to explore alternate timelines—so we preserve those artifacts as `inactive`.
3. **Principle 4 (Scene-Scoped Context)**: Context injection stays 100% clean because inactive timeline artifacts are strictly filtered out of active prompt assembly.