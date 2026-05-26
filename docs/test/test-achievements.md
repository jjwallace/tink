# Achievement Cards

DOM-based frosted glass cards that spawn when plan steps complete.

## Behavior

- Cards launch from the completed node's screen position
- GSAP animates: scale 0→1 with back.out easing, drift to a landing zone
- Cards linger for 6 seconds, then fade + drift upward
- Multiple rapid completions stagger with 300ms delays

## Zone Layout

8 zones clustered around the graph area (bottom-center):
- Left column: x=0.18-0.25, y=0.58-0.82
- Right column: x=0.75-0.82, y=0.58-0.82
- Bottom row: x=0.35-0.65, y=0.90

Zones cycle to prevent clustering. Memory resets when all 8 have been used.

## Styling

- Background: rgba(20, 20, 30, 0.85) with backdrop-filter blur
- Left border: 3px solid in category color
- Category colors: green (created), amber (modified), blue (test), purple (build), gold (milestone)
- Text: 12px SF Pro with black text-shadow for contrast
