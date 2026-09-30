# Assessment UI design system

## Reference

Source: the supplied eight-board ScholiPhi assessment HTML/PDF in Downloads. Use its composition and content hierarchy, with live data instead of sample names and numbers. The reference's large dark-plum header, Georgia-style serif headings, pale lavender canvas, fine lavender borders, indigo actions and green/amber/red score states are intentional.

## Shared tokens

`--color-bg`: pale lavender; `--color-surface`: near-white; `--color-text`: dark navy/plum; `--color-muted`: muted purple; `--color-border`: light lavender; `--color-primary`: indigo; `--color-success`: forest green; `--color-warning`: amber; `--color-danger`: muted red. New styles use these tokens. Body uses a system sans; headings use Georgia and serif fallbacks. Reference typography and structure take priority over generic skill defaults.

## Layout

A single shared navy header contains the ScholiPhi wordmark, context breadcrumb, and relevant page actions. Use generous desktop page padding (32–48px), 20–24px section gaps, and restrained thin borders. Teacher reports use wide compact tables and deliberate 60/40 and 50/50 rows. The question screen has paper left and question list right. Answer review has an approximately equal paper/feedback split. The scheme screen has a question sidebar, the active answer and mark criteria, then marking rules. A five-step navigation shows Upload, Check questions, Answers, Rules, Publish.

## Components and states

Native buttons, labelled forms, accessible status chips, bordered sections, indigo primary actions, green approval actions, inline validation and clear loading states. Tables scroll inside their own wrappers on narrow screens. Paper and feedback stack on mobile. Use ordinary links for navigation, real print/download/copy actions, and explicit draft state for follow-up plans. Parent and student routes contain no teacher-only editing controls.

## Scope of this alignment

Reuse the supplied layouts; no new image generation is needed. Existing scans are the visual evidence. Preserve the mark-total, teacher-approval and release protections. Do not manufacture integrations for school attendance, parent messaging or question-bank resources.
