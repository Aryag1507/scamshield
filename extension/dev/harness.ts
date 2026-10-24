// Order matters: install the chrome.* stand-in before the extension code runs.
import "./chrome-mock";
import "../src/background";
import "../src/content-email";
import "../src/overlay";
