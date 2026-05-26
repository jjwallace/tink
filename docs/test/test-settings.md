# Color Swatches in Settings

The VFX color picker was changed from text pill buttons to small colored squares.

## Component: ColorSwatchRow

Renders 24x24px colored squares with:
- Active: 2px solid white border + colored box-shadow glow
- Inactive: 2px solid dim border, no glow
- Hover: GSAP scale 1.1
- Click: GSAP scale bounce (0.9 → 1.15 → 1)
- Title attribute shows the color name on hover

## Colors Available

| Color | Hex | Swatch |
|-------|-----|--------|
| Purple | #a78bfa | default |
| Cyan | #64d8ff | |
| Green | #4ade80 | |
| Orange | #f97316 | |
| Rose | #f43f5e | |
| Gold | #facc15 | |

Only the `vfx_color` setting uses swatches. All other settings keep the existing text pill UI.
