import { renderSettings, SETTINGS_CSS } from "./ui/settings";

const style = document.createElement("style");
style.textContent = SETTINGS_CSS;
document.head.append(style);
void renderSettings(document.getElementById("features") as HTMLElement);
