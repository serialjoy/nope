# Nope: Side-eye brand skin

Apply the user's selected Side-eye brand board to the existing app. The latest request restores the full branded design and character tiles from before the white-background and photographic revisions. Restore the cream, forest, tomato, bubblegum and butter palette with the original six generated character illustrations. Existing Gemini classification, penalty rules, previews, Teach Nope requests, persistence and all APIs stay intact. Band remains 58. Main repo is this folder (`pause`); do not touch the Vexo SDK or secrets.

Reference image: `/var/folders/h8/_rldf3tx3jq_tzt3nkw4gnq00000gn/T/codex-clipboard-fc43c733-1839-4f79-a8a8-c770fac55c18.png`.

## Design decisions

- Restore the earlier full-brand CSS: cream surfaces, forest text and navigation, tomato actions, butter and bubblegum accents. Preserve the mobile-centered app, all structural layouts and readable contrast.
- Typography and heading treatment should follow the earlier full-brand iteration, before the white-background rollback. Recover prior values where available rather than invent a new direction.
- Home headline `Not on<br>my watch.` and supporting copy `Pick a habit. We'll keep an eye on it.` Keep clear input label `What do you want to stop?`, current example placeholder, six exact category labels and semantics.
- The signature is the brand's side-eye mark: orange circle/rounded square, two cream eyes looking right with forest pupils. Replace every old square-stop logo across headers, notification previews, and help. Use a local standalone SVG wordmark and SVG icon, crisp and dependency-free. Do not insert the entire brand board or its stock-photo mockups into the UI.
- Wordmark: lowercase `nope` in heavy rounded forest letters, with an oversized tomato circular `o`, cream central counter and two small side-looking tomato eyes/pupils inside the cream center, matching the large wordmark on the board. Supply self-contained path-based SVG (no external fonts). The icon follows the separate orange rounded-square app icon with cream eye shapes and forest pupils; transparent outside. Reproduce the selected design faithfully, do not invent a different mascot.
- Accessible names remain `Nope`; decorative repeated brand images can be aria-hidden. Header image dimensions should reserve space; roughly 120–135px wide on home, 105–115px on inner screens, 72–80px notification wordmark. Adapt to 320px with no header overflow.
- Retain SVG favicon using the icon and restore cream theme-color. Page title remains Nope.
- No new animations needed; preserve reduced-motion and visible keyboard focus. All controls retain their behavior and clear labels.

## Restored character tiles

Restore the exact six previously generated Higgsfield PNGs under `public/assets/tiles/{behaviorId}.png`: scrolling, nail_biting, vaping, smoking, porn, and snacking. No new image generation. Display compact transparent character art on colored rounded cards with the original labels, order and actions. `.starter-art` images stay decorative (`alt=""`) because the visible labels name the action. The photographic JPEGs may remain unused to preserve that iteration. Do not roll back functional commits or rewrite Git history.

## Ownership

- CSS executor owns `public/styles.css` only. Restore the earlier full-brand design while retaining all structural behaviors.
- Markup/assets executor owns `public/app.js`, `public/index.html`, and `public/assets/tiles/`. Restore PNG references and cream theme-color; no functional/API refactors. Existing logo SVGs remain intact.
- Other agents may edit concurrently; never revert/overwrite their work. No commits or external publishing from executors, no keys or .data access, no toolkits.
- Coordinator reviews visuals at mobile widths, exercises main flows, and handles any publish step under prior user authorization. No new cosmetic-only tests; run syntax checks and existing tests as appropriate.
