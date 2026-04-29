---
name: Napolyrewardfarmor Scanner
description: Snapshot-first Polymarket LP opportunity console optimized for fast operator decisions.
colors:
  bg-base: "#0a0f14"
  bg-elevated: "#121923"
  bg-panel: "#16202d"
  border-subtle: "#233246"
  border-strong: "#2f445d"
  text-primary: "#dfe9f5"
  text-secondary: "#9cb1c8"
  text-dim: "#7087a2"
  accent-primary: "#39d98a"
  accent-primary-soft: "#16382d"
  accent-secondary: "#63b3ff"
  accent-warning: "#f3b34c"
  accent-danger: "#f26d7d"
  accent-info: "#83b8ff"
typography:
  display:
    fontFamily: "Manrope, Inter, Segoe UI, sans-serif"
    fontSize: "clamp(1.5rem, 1.2rem + 1.1vw, 2.2rem)"
    fontWeight: 700
    lineHeight: 1.15
  title:
    fontFamily: "Manrope, Inter, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Manrope, Inter, Segoe UI, sans-serif"
    fontSize: "0.9rem"
    fontWeight: 500
    lineHeight: 1.45
  label:
    fontFamily: "JetBrains Mono, SFMono-Regular, Menlo, monospace"
    fontSize: "0.72rem"
    fontWeight: 600
    lineHeight: 1.25
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "14px"
  lg: "20px"
  xl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.accent-primary-soft}"
    textColor: "{colors.accent-primary}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
  button-primary-hover:
    backgroundColor: "{colors.accent-primary}"
    textColor: "{colors.bg-base}"
  input-default:
    backgroundColor: "{colors.bg-panel}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
---

# Design System: Napolyrewardfarmor Scanner

## 1. Overview

**Creative North Star: "Operator Console in a Night Market"**

This system is a product-grade trading console focused on speed of understanding. It favors strong contrast, compact rhythm, and clear state communication over decorative styling. The visual model is a calm dark surface with high-signal accents, where the user can rank, compare, and drill into opportunities without friction.

The interface rejects generic dashboard tropes that hide signal in ornamental cards or over-animated effects. It also rejects noisy neon treatments that reduce trust in numbers. This is an execution surface, not a marketing page.

**Key Characteristics:**
- Snapshot-first hierarchy with immediate ranking context.
- Monospace support for data precision and scan consistency.
- Clear semantic states for live, warning, stale, and error conditions.

## 2. Colors

The palette is restrained-dark with one dominant positive accent and one supporting cool accent.

### Primary
- **Execution Mint** (`#39d98a`): CTA highlights, active controls, live-positive indicators.

### Secondary
- **Signal Blue** (`#63b3ff`): Informational state and secondary emphasis.

### Neutral
- **Midnight Base** (`#0a0f14`): App background.
- **Control Slate** (`#16202d`): Inputs and interactive surfaces.
- **Boundary Steel** (`#233246`): Default borders and separators.
- **Readable Frost** (`#dfe9f5`): Primary text.

### Named Rules
**The Signal Budget Rule.** Accent color is reserved for actionable or state-critical elements, never used as general decoration.

## 3. Typography

**Display Font:** Manrope (fallback Inter, Segoe UI, sans-serif)
**Body Font:** Manrope (fallback Inter, Segoe UI, sans-serif)
**Label/Mono Font:** JetBrains Mono (fallback SFMono-Regular, Menlo, monospace)

**Character:** Human but precise. Sans for readability, mono for operational labels and data rhythm.

### Hierarchy
- **Display** (700, clamp 1.5rem-2.2rem, 1.15): major section titles and key surface heading.
- **Title** (600, 1rem, 1.3): row headlines and panel section titles.
- **Body** (500, 0.9rem, 1.45): descriptive copy and secondary information.
- **Label** (600, 0.72rem, 1.25): compact control labels and metric captions.

### Named Rules
**The Numeric Clarity Rule.** Data-bearing values should remain visually stable with mono-friendly alignment and no decorative typography.

## 4. Elevation

Depth is primarily tonal, with selective shadows only for raised detail contexts. Most surfaces rely on background separation and border contrast rather than heavy blur or glow.

### Shadow Vocabulary
- **Panel Lift** (`0 14px 42px rgba(5, 10, 16, 0.45)`): expanded detail panel and high-focus containers.
- **Control Focus Halo** (`0 0 0 3px rgba(99, 179, 255, 0.22)`): keyboard focus emphasis.

### Named Rules
**The Flat-By-Default Rule.** Core list rows remain flat unless a state change requires explicit emphasis.

## 5. Components

### Buttons
- **Shape:** compact rectangle (`6px`) with medium weight text.
- **Primary:** mint-on-dark for active command actions.
- **Hover/Focus:** hover inverts for strong affordance; focus ring is always visible in keyboard flow.
- **Ghost/Secondary:** low-emphasis controls keep semantic distinction without visual noise.

### Cards / Containers
- **Corner Style:** medium rounding (`10px-14px`) for panels only.
- **Background:** layered dark surfaces with clear boundary contrast.
- **Border:** always explicit; no side-stripe accents.

### Inputs / Fields
- **Style:** filled dark controls with subtle border.
- **Focus:** blue border + halo for clear keyboard target.
- **Error:** danger tint background and border with readable foreground.

### Navigation and Filters
- Compact, sticky operator band for filters and mode toggles.
- Labels use uppercase mono style for fast grouping recognition.

## 6. Do's and Don'ts

### Do:
- **Do** prioritize ranking metrics and sorting context above decorative elements.
- **Do** keep control states explicit (default, hover, focus, active, disabled).
- **Do** preserve clear contrast between row text, metadata, and status highlights.
- **Do** keep mobile interaction targets usable with touch-friendly sizing.

### Don't:
- **Don't** use colored `border-left` accents as semantic emphasis.
- **Don't** use pure black (`#000`) or pure white (`#fff`) in production UI surfaces.
- **Don't** introduce gradient text, glass-like blur cards, or novelty chart effects.
- **Don't** reintroduce duplicate visual vocabularies between global CSS and shared primitives.
