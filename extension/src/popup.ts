import { DEFAULT_SETTINGS } from "./types";
import { createCard } from "./ui/card";
import { runCheck } from "./ui/check";

const form = document.getElementById("form") as HTMLFormElement;
const textarea = document.getElementById("text") as HTMLTextAreaElement;
const submit = document.getElementById("submit") as HTMLButtonElement;
const resultSlot = document.getElementById("result") as HTMLDivElement;
const autoscan = document.getElementById("autoscan") as HTMLInputElement;

let cancel = () => {};

function check(): void {
  const text = textarea.value.trim();
  if (!text) return textarea.focus();
  cancel(); // a newer check always wins
  const { host, render } = createCard({ brand: false });
  resultSlot.replaceChildren(host);
  submit.disabled = true;
  const channel = /^https?:\/\/\S+$/.test(text) ? "webpage" : text.length > 600 ? "email" : "sms";
  cancel = runCheck({ text, channel }, (s) => {
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

void chrome.storage.sync.get(DEFAULT_SETTINGS).then((s) => {
  autoscan.checked = Boolean(s.autoScan);
});
autoscan.addEventListener("change", () => void chrome.storage.sync.set({ autoScan: autoscan.checked }));
