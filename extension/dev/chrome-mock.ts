/**
 * Minimal in-page stand-in for the chrome.* APIs the extension uses, so the real
 * background + content code can run together on a local test page (dev/gmail.html)
 * against the live API. Ports are linked pairs delivering messages asynchronously,
 * like real extension ports.
 */

type Listener<T extends unknown[]> = (...args: T) => void;
const event = <T extends unknown[]>() => {
  const ls: Listener<T>[] = [];
  return { addListener: (l: Listener<T>) => ls.push(l), fire: (...a: T) => ls.forEach((l) => l(...a)) };
};

function makePortPair(name: string) {
  const mk = () => ({ name, onMessage: event<[unknown]>(), onDisconnect: event<[]>(), other: null as any, closed: false,
    postMessage(m: unknown) { const o = this.other; if (!this.closed && !o.closed) setTimeout(() => o.onMessage.fire(structuredClone(m))); },
    disconnect() { if (this.closed) return; this.closed = true; const o = this.other; if (!o.closed) { o.closed = true; setTimeout(() => o.onDisconnect.fire()); } } });
  const a = mk(), b = mk();
  a.other = b; b.other = a;
  return [a, b];
}

const onConnect = event<[unknown]>();
const store = (initial: Record<string, unknown> = {}) => ({
  data: initial,
  async get(keys?: Record<string, unknown> | string) {
    if (typeof keys === "string") return { [keys]: this.data[keys] };
    return { ...(keys ?? {}), ...this.data };
  },
  async set(items: Record<string, unknown>) {
    const changes = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }]));
    Object.assign(this.data, items);
    onChanged.fire(changes, this === sync ? "sync" : "session");
  },
});
const onChanged = event<[Record<string, unknown>, string]>();
const sync = store();

(globalThis as any).chrome = {
  runtime: {
    connect: ({ name }: { name: string }) => { const [page, bg] = makePortPair(name); setTimeout(() => onConnect.fire(bg)); return page; },
    onConnect,
    onInstalled: event<[]>(),
    onMessage: event<[unknown]>(),
  },
  storage: { session: store(), sync, onChanged },
  contextMenus: { create() {}, onClicked: event<[]>() },
  scripting: { async executeScript() {} },
  tabs: { async sendMessage() {} },
};
