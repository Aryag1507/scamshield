import { FEATURE_IDS, FEATURES } from "../features";
import { DEFAULT_SETTINGS, type Feature, type Settings } from "../types";

/**
 * The three opt-in switches (chats, websites, email). Turning one on asks Chrome for that
 * feature's site access; it only stays on if the user approves. Shared by the popup and
 * the welcome page.
 */
export async function renderSettings(container: HTMLElement): Promise<void> {
  const settings = (await chrome.storage.sync.get(DEFAULT_SETTINGS)) as Settings;
  container.replaceChildren(...FEATURE_IDS.map((id) => row(id, settings[id])));

  // Stay in sync if access is revoked elsewhere (background flips the setting off).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const id of FEATURE_IDS) {
      const input = container.querySelector<HTMLInputElement>(`input[data-feature="${id}"]`);
      if (input && id in changes) input.checked = Boolean(changes[id].newValue);
    }
  });
}

function row(id: Feature, on: boolean): HTMLElement {
  const f = FEATURES[id];
  const label = document.createElement("label");
  label.className = "feature";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.feature = id;
  input.checked = on;
  input.setAttribute("role", "switch");
  const text = document.createElement("span");
  text.innerHTML = `<strong></strong><small></small>`;
  text.querySelector("strong")!.textContent = f.title;
  text.querySelector("small")!.textContent = f.description;
  label.append(input, text);

  input.addEventListener("change", async () => {
    if (!input.checked) {
      await chrome.storage.sync.set({ [id]: false });
      return;
    }
    // Must be called straight from the user's click for Chrome to show the prompt.
    const granted = await chrome.permissions.request({ origins: f.origins });
    input.checked = granted;
    await chrome.storage.sync.set({ [id]: granted });
  });
  return label;
}

export const SETTINGS_CSS = `
.features { display: grid; gap: 4px; }
.feature { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border-radius: 10px; cursor: pointer; }
.feature:hover { background: color-mix(in srgb, currentColor 5%, transparent); }
.feature input { appearance: none; flex: none; width: 32px; height: 18px; margin: 2px 0 0; border-radius: 999px;
  background: color-mix(in srgb, currentColor 22%, transparent); position: relative; cursor: pointer; transition: background .15s; }
.feature input::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: transform .15s; }
.feature input:checked { background: var(--accent); }
.feature input:checked::after { transform: translateX(14px); }
.feature input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.feature strong { display: block; font-weight: 600; }
.feature small { display: block; color: var(--muted); font-size: 12px; line-height: 1.4; margin-top: 1px; }
@media (prefers-reduced-motion: reduce) { .feature input, .feature input::after { transition: none; } }
`;
