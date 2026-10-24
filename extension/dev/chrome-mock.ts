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

const granted = new Set<string>();
const registered = new Map<string, unknown>();

(globalThis as any).chrome = {
  permissions: {
    // The test page auto-approves (a real browser shows Chrome's prompt here).
    async request({ origins }: { origins: string[] }) { origins.forEach((o) => granted.add(o)); return true; },
    async contains({ origins }: { origins: string[] }) { return origins.every((o) => granted.has(o) || granted.has("<all_urls>")); },
    async remove({ origins }: { origins: string[] }) { origins.forEach((o) => granted.delete(o)); return true; },
    onRemoved: event<[]>(),
    _granted: granted,
  },
  runtime: {
    id: "scamshield-test-page", // real extensions always have one; content scripts check it
    connect: ({ name }: { name: string }) => { const [page, bg] = makePortPair(name); setTimeout(() => onConnect.fire(bg)); return page; },
    onConnect,
    onInstalled: event<[]>(),
    onStartup: event<[]>(),
    getURL: (p: string) => p,
    onMessage: event<[unknown]>(),
  },
  storage: { session: store(), sync, onChanged },
  contextMenus: { create() {}, onClicked: event<[]>() },
  scripting: {
    async executeScript() {},
    async getRegisteredContentScripts() { return [...registered.values()]; },
    async registerContentScripts(scripts: { id: string }[]) {
      for (const sc of scripts) {
        if (registered.has(sc.id)) throw new Error(`Duplicate script ID '${sc.id}'`);
        registered.set(sc.id, sc);
      }
    },
    async unregisterContentScripts({ ids }: { ids: string[] }) { ids.forEach((id) => registered.delete(id)); },
    _registered: registered,
  },
  tabs: { async sendMessage() {}, async query() { return []; }, async create() {} },
};
