# Display Modes

Native supports three visual modes for displaying spoken text, selectable from Settings > Display in the tray menu.

## Bubbles (Default)

Floating sentence bubbles that appear at the cursor position and drift upward.

- Each sentence gets its own dark rounded card
- Active sentence renders at 28px, shrinks to 16px after reading
- Words highlight blue as they're spoken
- Finished bubbles fade out after 1.5 seconds
- Multiple bubbles can be on screen at once, stacking vertically

## Scroll (Teleprompter)

A horizontal ribbon of text that scrolls across the screen.

- Text enters from the right side at 0.75x scale
- Zooms to 1.15x during reading (slow, smooth glide)
- Active word highlights blue via GSAP color transition
- Zooms back to 0.65x and exits left when done
- Container movement is lerped at 0.035 for buttery smoothness
- Per-word properties (opacity, position) are individually lerped

## Paragraph (Panel)

A dark semi-transparent panel centered on screen.

- Sentences revealed progressively with fade-in as TTS generates them
- Active word highlights blue, auto-scroll keeps it centered
- Spinner shown while generating
- Panel zooms in on open, zooms out on close
