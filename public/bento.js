// Nope bento: small enhancements for the "at a glance" section.
// The section is complete without this file; everything here is optional polish.

const root = document.querySelector(".nb");

if (root) {
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  linkStakeToAmount(root);
  if (!calm) {
    rotateExamples(root);
    wakeEyes(root);
  }
}

// Picking $1, $5 or $10 in the stake tile updates the amount shown elsewhere.
function linkStakeToAmount(scope) {
  const options = [...scope.querySelectorAll('input[name="nb-stake"]')];
  const slots = scope.querySelectorAll("[data-nb-amount]");
  if (!options.length || !slots.length) return;

  const sync = () => {
    const chosen = options.find((option) => option.checked);
    if (!chosen) return;
    for (const slot of slots) slot.textContent = chosen.value;
  };

  for (const option of options) option.addEventListener("change", sync);
  sync();
}

// The description tile cycles through a few ways of saying it.
// Labels on the right must stay exactly as the app spells them.
function rotateExamples(scope) {
  const examples = [
    ["I want to stop doom-scrolling at night.", "Doom-scroll"],
    ["No more biting my nails in meetings.", "Nail biting"],
    ["Stop me raiding the snack drawer.", "Snacks"],
    ["I’m done with vaping.", "Vaping"],
  ];
  const tile = scope.querySelector(".nb-describe");
  const text = tile?.querySelector('[data-nb-example="text"]');
  const label = tile?.querySelector('[data-nb-example="label"]');
  if (!tile || !text || !label) return;

  let index = 0;
  let held = false;
  tile.addEventListener("pointerenter", () => { held = true; });
  tile.addEventListener("pointerleave", () => { held = false; });

  window.setInterval(() => {
    if (held || document.hidden) return;
    index = (index + 1) % examples.length;
    tile.classList.add("nb-swap");
    window.setTimeout(() => {
      [text.textContent, label.textContent] = examples[index];
      tile.classList.remove("nb-swap");
    }, 220);
  }, 4200);
}

// The hero eyes look ahead until they scroll into view, then cut to the
// side-eye. With a mouse they follow the pointer across the section and
// return to the side-eye when it rests or leaves.
function wakeEyes(scope) {
  const hero = scope.querySelector(".nb-hero");
  const pupils = hero ? [...hero.querySelectorAll(".nb-pupil")] : [];
  if (!pupils.length) return;

  if ("IntersectionObserver" in window) {
    hero.classList.add("nb-ahead");
    const watcher = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      watcher.disconnect();
      window.setTimeout(() => hero.classList.remove("nb-ahead"), 520);
    }, { threshold: 0.55 });
    watcher.observe(hero);
  }

  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

  const reach = 10; // SVG units; the same travel as the resting side-eye
  let frame = 0;
  let restTimer = 0;
  let pointer = null;

  const rest = () => {
    pointer = null;
    hero.classList.remove("nb-tracking");
    for (const pupil of pupils) {
      pupil.style.removeProperty("--nb-px");
      pupil.style.removeProperty("--nb-py");
    }
  };

  const look = () => {
    frame = 0;
    if (!pointer) return;
    for (const pupil of pupils) {
      const eye = pupil.parentElement.getBoundingClientRect();
      const dx = pointer.x - (eye.left + eye.width / 2);
      const dy = pointer.y - (eye.top + eye.height / 2);
      const distance = Math.hypot(dx, dy) || 1;
      const pull = Math.min(1, distance / (eye.width * 1.2));
      pupil.style.setProperty("--nb-px", `${((dx / distance) * reach * pull).toFixed(2)}px`);
      pupil.style.setProperty("--nb-py", `${((dy / distance) * reach * pull).toFixed(2)}px`);
    }
  };

  scope.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse" || hero.classList.contains("nb-ahead")) return;
    pointer = { x: event.clientX, y: event.clientY };
    hero.classList.add("nb-tracking");
    if (!frame) frame = window.requestAnimationFrame(look);
    window.clearTimeout(restTimer);
    restTimer = window.setTimeout(rest, 1600);
  });

  scope.addEventListener("pointerleave", () => {
    window.clearTimeout(restTimer);
    rest();
  });
}
