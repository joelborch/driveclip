# DriveClip design contract (v2 — light)

One product, three surfaces (extension popup, mic-permission page, share dashboard).
Direction: **bright, Linear-inspired product UI.** Near-white surfaces, crisp hairline
borders, quiet gray secondary text, generous spacing, restrained shadows. Red exists
for exactly one purpose: the act of recording (record/stop controls, live-recording
indicators). Nothing else is red. No dark themes anywhere.

## Palette

```css
--bg:        #FDFDFD;  /* page background (popup) */
--page:      #F7F7F8;  /* page background behind cards (mic page, dashboard) */
--surface:   #F4F5F6;  /* inset fields, segmented track */
--card:      #FFFFFF;  /* raised cards */
--line:      #E4E5E9;  /* hairline borders */
--text:      #1B1D21;  /* primary text */
--dim:       #70747D;  /* secondary text */
--faint:     #9CA0A8;  /* tertiary/hints */
--red:       #E5484D;  /* record/stop/live ONLY */
--green:     #2F9E44;  /* success confirmations */
--primary:   #1F2126;  /* primary buttons: near-black, white text */
--focus:     #5E9ED6;  /* focus rings */
```

Amber notice: bg #FFF7E6 / border #F2DFB7 / text #8A6116.
Error: bg #FDF0F0 / border #F3D2D3 / text #B03538.

## Typography

System sans (-apple-system stack), 13px UI / 15-16px page body. Semibold headlines
with -0.015em tracking. Monospace (ui-monospace stack) ONLY for the recording timer
and file ids. Sentence case everywhere; no uppercase-tracked eyebrow labels.
Dashboard landing may keep one display face (Bricolage Grotesque) for the hero if it
reads well on light; otherwise system semibold is fine.

## Components

- Radius: 8px controls, 10-12px cards. Shadows subtle: 0 1px 2-3px rgba(20,21,26,.06-.08).
- Primary button: solid --primary, white text. Ghost: white bg, 1px --line, --dim text.
- Record button (popup): 58px solid --red circle with white+hairline double ring.
- Segmented control: --surface track, active cell white with hairline + tiny shadow.
- Focus: 2px --focus outline, offset 2px. prefers-reduced-motion respected.
- Dashboard viewer: white card frame around the player on --page; player letterbox
  itself may stay near-black (video needs it) — that is not "dark theme", it's a screen.

## Voice

Sentence case, plain verbs, buttons say what they do. Errors state what happened and
the next step. No drama.

## Hard constraints

Unchanged from v1: never break JS hooks (ids, data-*, classes referenced by
popup.js / mic.js / viewer script); extension pages make no external requests;
dashboard asset links stay root-absolute; 404.html stays byte-identical to v.html.
