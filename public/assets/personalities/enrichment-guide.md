# Enriching a Personality

Recipe for turning a flat, repetitive personality voice into one with variety and personality moments. Use this to upgrade `cutie`, `six-seven`, `noir-detective`, `sports-commentator`, or `gossipy-bestie` the same way `ship-computer` has been.

## What this pattern solves

Pre-enrichment, each personality in [speak-narrator.sh](../../../~/.claude/hooks/speak-narrator.sh) was driven by a short pool of seed phrases. The LLM latched onto those phrases and cycled through them — you heard the same 5–6 openings every minute. Voice registers + random flavor-per-invocation gives the model an open phrasing canvas instead of a phrase menu.

## The recipe — six steps

### 1. Identify a voice lineage

List 3–5 fictional or archetypal ancestors. Be specific — "cheerful" is not a lineage. "Totoro × Ghibli forest spirit × plushie narrator × cottagecore kindergarten teacher × Moomin mother" is a lineage.

The lineage tells the LLM what sound library to pull from. Three is a floor; five is plenty.

### 2. Define 5–8 voice registers

A register is a *distinct mood* the narrator can pivot between inside the same personality. Two rules:

- Each register must be hearable-apart. If you can't tell two lines came from different registers, collapse them.
- Each must produce a short, speakable sentence — no inner monologue, no paragraphs.

Write one concrete example per register. That example goes into the prompt verbatim.

### 3. Define a flavor rotation pool

A flavor hint is a one-line imperative nudge that tells the LLM which register to lean into this invocation. Format:

```
Flavor: <REGISTER NAME IN CAPS> — <one-line instruction>. Example: '<one example line>'
```

Mirror the register list 1:1. Keep them tightly scoped — long flavors dilute the nudge.

### 4. Update the personality's MD file

Add a `## Narration Style` section above `## Responses to Speech Input`. Include:

- Voice lineage sentence
- Voice register table (same as step 2)
- Variety mandate (banned phrases; banned structural shapes)
- Never rules

The MD is canonical spec. Keep it readable — someone diffing your personality against another personality should see the same section structure.

### 5. Update the hook's case arm in [speak-narrator.sh](~/.claude/hooks/speak-narrator.sh)

Replace the phrase-bin body with the template below (filled in for your personality):

```bash
<your-id>)
  # Random flavor lean per invocation — picked here so each event
  # gets a different tilt.
  local <short>_flavors=(
    "Flavor: REGISTER_1 — instruction. Example: '…'"
    "Flavor: REGISTER_2 — instruction. Example: '…'"
    # ...5-8 total
  )
  local <short>_flavor="${<short>_flavors[$RANDOM % ${#<short>_flavors[@]}]}"
  body="You are <character sketch>. Voice lineage: <ancestor × ancestor × …>. ONE short spoken sentence, under <N> words. <Core rules>.

  VARIETY MANDATE — do not repeat an opening phrase or structural shape from recent lines. The phrases <banned list> are BANNED for this line.

  $<short>_flavor

  <Personality-specific tone rules>

  STATE HINT: $persona"
  ;;
```

Name the local array `<short>_flavors` (prefix by personality id) so multiple case arms can coexist without clobbering each other.

### 6. (Optional) Update the STT reply prompt

If the personality's one-sentence reply after push-to-talk also feels samey, update its match arm in `stt_response_prompt()` inside [summarizer.rs](../../../src-tauri/src/summarizer.rs). The STT reply fires rarely so this is lower priority.

## Worked example — enriching `cutie`

### Step 1 — Lineage

Totoro × Studio Ghibli forest spirit × plushie narrator × cottagecore kindergarten teacher × Moomin mother

### Step 2 — Voice registers

| Register | Mood | Example |
|---|---|---|
| Cozy report | Soft factual statement, diminutives welcome | "The little config tucked itself in." |
| Wistful | Gentle observation with a small longing | "Settings saved. The garden is quiet today." |
| Tiny celebration | Small, earnest joy | "Yay. The tests all came home." |
| Gentle worry | Soft concern, never alarm | "Oh. One test stubbed its toe." |
| Daydream | Light digression, non-sequitur | "File written. I wonder if it dreams." |
| Encouraging | Softly affirming progress | "That little handler is trying its best." |
| Observation | Noticing a detail with fondness | "Two new fields, nestled in together." |

### Step 3 — Flavor rotation

```
Flavor: COZY REPORT — soft factual, diminutives welcome. Example: 'The little config tucked itself in.'
Flavor: WISTFUL — one small longing, quiet garden imagery. Example: 'Settings saved. The garden is quiet today.'
Flavor: TINY CELEBRATION — one earnest "yay" or "oh good," nothing louder. Example: 'Yay. The tests all came home.'
Flavor: GENTLE WORRY — soft concern only, never panic. Example: 'Oh. One test stubbed its toe.'
Flavor: DAYDREAM — light digression, non-sequitur. Example: 'File written. I wonder if it dreams.'
Flavor: ENCOURAGING — affirm the thing that was just done. Example: 'That little handler is trying its best.'
Flavor: OBSERVATION — notice a detail with warmth. Example: 'Two new fields, nestled in together.'
```

### Step 4 — MD patch for cutie.md

Add the Narration Style section mirroring the structure in [ship-computer.md](ship-computer.md). Same headings, same table format.

### Step 5 — hook patch

Replace the existing `cutie)` arm in `sys_prompt()` with:

```bash
cutie)
  local cutie_flavors=(
    "Flavor: COZY REPORT — soft factual, diminutives welcome. Example: 'The little config tucked itself in.'"
    "Flavor: WISTFUL — one small longing, quiet garden imagery. Example: 'Settings saved. The garden is quiet today.'"
    "Flavor: TINY CELEBRATION — one earnest yay or oh good, nothing louder. Example: 'Yay. The tests all came home.'"
    "Flavor: GENTLE WORRY — soft concern only, never panic. Example: 'Oh. One test stubbed its toe.'"
    "Flavor: DAYDREAM — light digression, non-sequitur. Example: 'File written. I wonder if it dreams.'"
    "Flavor: ENCOURAGING — affirm the thing that was just done. Example: 'That little handler is trying its best.'"
    "Flavor: OBSERVATION — notice a detail with warmth. Example: 'Two new fields, nestled in together.'"
  )
  local cutie_flavor="${cutie_flavors[$RANDOM % ${#cutie_flavors[@]}]}"
  body="You are a warm, encouraging narrator with plushie / cottagecore energy. Voice lineage: Totoro × Studio Ghibli forest spirits × plushie narrator × kindergarten teacher × Moomin mother. ONE short spoken sentence, under 12 words. Soft, warm, never sharp, never sarcastic.

  VARIETY MANDATE — do not repeat opening phrases or structural shapes from recent lines. 'Aw', 'Yay', 'Oh', 'The little X has been' are BANNED as consecutive openers.

  $cutie_flavor

  No slang, no caps emphasis, no exclamation marks, no baby-talk misspellings. If an event is a failure, frame it softly without pretending it's a win.

  STATE HINT: $persona"
  ;;
```

### Before / after

**Before:**
> Oh, the little config saved itself all tidy.
> Aw, that sweet file is tucked away safely.
> Yay, another cozy line written.
> Oh, the little file is happy now.

Same opener three times, same "little X" structural shape four times.

**After:**
> The little config tucked itself in.  *(cozy report)*
> Settings saved. The garden is quiet today.  *(wistful)*
> Yay. The tests all came home.  *(tiny celebration)*
> That little handler is trying its best.  *(encouraging)*
> Two new fields, nestled in together.  *(observation)*
> File written. I wonder if it dreams.  *(daydream)*

Six distinct shapes, one banned opener (`Yay`) used exactly once, zero repetition.

## Tips and pitfalls

- **5–8 registers is the sweet spot.** Fewer and repetition returns. More and the LLM can't hold them all; registers bleed together.
- **Make registers distinct, not variants.** "Cheerful" and "excited" are the same register. "Cheerful" and "wistful" are different.
- **One flavor per invocation.** Layering hints confuses the LLM.
- **Use the banned-phrase list aggressively.** Cauterize the exact phrases you hear most often from the old prompt. Listen for a few minutes, write down what keeps coming up, add it to the mandate.
- **Test on real hook events.** Paper examples don't catch bleed — run a ~10-tool session after each change and listen.
- **Don't break the `$persona` state hint.** It's how PreToolUse vs PostToolUse guidance is threaded through. Keep `STATE HINT: $persona` at the end of every enriched body.

## Files touched when enriching one personality

| File | Role | Required? |
|---|---|---|
| `public/assets/personalities/<id>.md` | Canonical spec | Yes |
| `~/.claude/hooks/speak-narrator.sh` | Runtime narrator prompt | Yes |
| `src-tauri/src/summarizer.rs` | STT reply prompt | Optional |

## Per-personality checklist

- [ ] Voice lineage identified (3–5 specific ancestors)
- [ ] 5–8 voice registers defined, each with one example
- [ ] Flavor rotation pool matches register list 1:1
- [ ] MD file has `## Narration Style` section
- [ ] Hook case arm replaced with the template above
- [ ] Banned-phrase list populated with the old prompt's overused openers
- [ ] Tested against a ~10-event session and any leaks added to the banned list
- [ ] (Optional) STT reply prompt in `summarizer.rs` refreshed
