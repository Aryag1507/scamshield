import { createCard } from "./ui/card";
import { runCheck } from "./ui/check";
import { renderSettings, SETTINGS_CSS } from "./ui/settings";
import { guessChannel } from "./webrisk";

const form = document.getElementById("form") as HTMLFormElement;
const textarea = document.getElementById("text") as HTMLTextAreaElement;
const submit = document.getElementById("submit") as HTMLButtonElement;
const resultSlot = document.getElementById("result") as HTMLDivElement;

let cancel = () => {};

function check(): void {
  const text = textarea.value.trim();
  if (!text) return textarea.focus();
  cancel(); // a newer check always wins
  const { host, render } = createCard({ brand: false });
  resultSlot.replaceChildren(host);
  submit.disabled = true;
  cancel = runCheck({ text, channel: guessChannel(text) }, (s) => {
    render(s);
    if (s.kind !== "checking") submit.disabled = false;
  }, true);
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  check();
});
textarea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    check();
  }
});

const style = document.createElement("style");
style.textContent = SETTINGS_CSS;
document.head.append(style);
void renderSettings(document.getElementById("features") as HTMLElement);
