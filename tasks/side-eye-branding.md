# Nope: Side-eye brand skin

Apply the user's selected Side-eye brand board to the existing app. Final user direction: retain the original white background, original fonts, black navigation/buttons and original UI panels; change the logo and home tile photography. Keep the headline bold and oversized. Existing Gemini classification, penalty rules, previews, Teach Nope requests, persistence and all APIs stay intact. Band remains 58. Main repo is this folder (`pause`); do not touch the Vexo SDK or secrets.

Reference image: `/var/folders/h8/_rldf3tx3jq_tzt3nkw4gnq00000gn/T/codex-clipboard-fc43c733-1839-4f79-a8a8-c770fac55c18.png`.

## Design decisions

- Keep the mobile centered app and original white screen, black text/nav/actions, original spacing and panels. Use the brand's forest and tomato colors in the logo; home cards contain warm, natural photography with white label areas.
- Typography: retain the original HEAD typography exactly: heavy Arial/Helvetica display and Inter/system body stack. The black oversized heading should keep its original impact. No new font, layout structure, or reduced type scale.
- Home headline `Not on<br>my watch.` and supporting copy `Pick a habit. We'll keep an eye on it.` Keep clear input label `What do you want to stop?`, current example placeholder, six exact category labels and semantics.
- The signature is the brand's side-eye mark: orange circle/rounded square, two cream eyes looking right with forest pupils. Replace every old square-stop logo across headers, notification previews, and help. Use a local standalone SVG wordmark and SVG icon, crisp and dependency-free. Do not insert the entire brand board or its stock-photo mockups into the UI.
- Wordmark: lowercase `nope` in heavy rounded forest letters, with an oversized tomato circular `o`, cream central counter and two small side-looking tomato eyes/pupils inside the cream center, matching the large wordmark on the board. Supply self-contained path-based SVG (no external fonts). The icon follows the separate orange rounded-square app icon with cream eye shapes and forest pupils; transparent outside. Reproduce the selected design faithfully, do not invent a different mascot.
- Accessible names remain `Nope`; decorative repeated brand images can be aria-hidden. Header image dimensions should reserve space; roughly 120–135px wide on home, 105–115px on inner screens, 72–80px notification wordmark. Adapt to 320px with no header overflow.
- Add SVG favicon using the icon and retain white theme-color. Page title remains Nope.
- No new animations needed; preserve reduced-motion and visible keyboard focus. All controls retain their behavior and clear labels.

## Final user addition: photographic home tiles

The user rejected the first illustrated tile set and supplied a candid cafe lifestyle photo as the preferred direction (`codex-clipboard-d51e2bf5-db49-4a8d-a96e-b33c9c08d7b6.png`). Use Higgsfield for six coordinated realistic lifestyle photos: adult hands, subtle black wristband, natural light, uncluttered close-up compositions. Subjects clearly suggest scrolling, nail biting, vaping, smoking, private laptop use (fully non-explicit), and snacking. No text/logo burned into images. Store final photos under `public/assets/tiles/{behaviorId}.jpg`; remove only superseded generated illustrations from the final app deliverable. Cards remain two columns with a full-width photo crop, rounded corners, white label area, subtle border, and the original actions/labels/order. The overall app stays white with its original fonts and black UI. `.starter-art` images are decorative (`alt=""`) because the visible labels name the action. All other UI icons stay compact and unchanged.

## Ownership

- CSS executor owns `public/styles.css` only. Start from original HEAD stylesheet and change only logo sizing and photographic starter tiles. Use `.brand-wordmark`, `.brand-icon`, `.home-headline-line` styles as needed. Do not remove structural behaviors.
- Markup/assets executor owns `public/app.js`, `public/index.html`, `public/assets/nope-wordmark.svg`, `public/assets/nope-icon.svg`, and `public/assets/tiles/`. Use local img assets instead of old `stop-mark` markup. Change visual copy only as above, no functional/API refactors.
- Other agents may edit concurrently; never revert/overwrite their work. No commits or external publishing from executors, no keys or .data access, no toolkits.
- Coordinator reviews visuals at mobile widths, exercises main flows, and handles any publish step under prior user authorization. No new cosmetic-only tests; run syntax checks and existing tests as appropriate.
