# Nope: "at a glance" bento

A bento-grid summary of Nope for the website, modelled on Apple's product summary grids and built in the Side-eye skin. Thirteen tiles, one per feature.

Preview with the app running: <http://127.0.0.1:3000/bento.html>

## Files

- `public/bento.html`: preview page. The reusable part is the single `<section class="nb">`.
- `public/bento.css`: every style, namespaced `.nb-*`. It does not load `styles.css`; its tokens mirror `:root` there (baseline commit `7a9dd69`).
- `public/bento.js`: optional polish. The section is complete with scripts off.

Reused by URL, not copied: `assets/nope-wordmark.svg`, `assets/nope-icon.svg`, `assets/tiles/*.png`. Nothing in `app.js`, `index.html`, `styles.css`, `assets/` or the backend was changed.

To put the section on another page, copy the `<section>`, `bento.css` and `bento.js`.

## Tiles and what each one depends on

| Tile | Copy | Depends on |
|---|---|---|
| Hero | Not on my watch. / Pick a habit. We’ll keep an eye on it. | Home headline and intro in `app.js` |
| Describe | Your words. Your rule. | Home input placeholder and caption; classifier |
| Habits | Six habits to start with. | `lib/behavior-catalog.mjs` labels, card colours and PNGs from the home grid |
| Stake | Set your stake. | `$1`, `$5`, `$10`; stake screen title in `simplified-rule-flow.md` |
| First | First time, a nudge. | Recurrence policy; nudge copy “Caught a loop? Take a breath. You can choose again.” |
| Next | Next time, your stake. | Recurrence policy |
| Reset | Then it resets. | Recurrence policy (“Until the next charge, then reset”) |
| Band | The band keeps watch. | The band and the separate detector |
| Pause | Pause anytime. | Pause and resume on a rule; states “Ready” and “Paused” |
| False alarm | False alarm? Say so. | “False alarm” on the nudge screen |
| Teach | Not on the list? Show Nope. | Teach Nope, 10-second example (`teach-nope.md`) |
| Preview | Try it first. No charge. | “Try it” and demo previews |
| Activity | See what happened. | Activity screen (the browser keeps the latest 80 entries) |

The small print under the grid restates the recurrence policy and “For adults 18+”.

## Keep in sync

- The three rule tiles and the small print follow `tasks/simplified-rule-flow.md`, not the older 60-second rule that `README.md` still describes. If the policy changes again, those four places change with it.
- Habit labels must match `lib/behavior-catalog.mjs` exactly, including the examples array in `bento.js`.
- If the palette or type in `styles.css` moves, update the tokens at the top of `bento.css`.

## Design rules

- Colour comes only from the five brand fields: tomato, cream, forest, butter, bubblegum. No shadows, no gradients.
- The hero eyes rest in the locked side-eye (pupils at the right edge). With a mouse they follow the pointer across the section, then return. Reduced motion keeps them still.
- Cream text on tomato stays at 18.7px bold or larger so it holds 3:1.
- No efficacy claims, no money imagery beyond the amounts themselves, adults only.

## Not done yet

- The six character PNGs are about 800 KB each. Fine locally; compress or resize before this page is public.
- No privacy or payments tile. Both need wording confirmed before they go on a public page.
