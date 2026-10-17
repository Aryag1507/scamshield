import { Checker } from "@/components/Checker";

const HF_URL = "https://huggingface.co/Aryag1507/scamshield-0.5b";
const GITHUB_URL = "https://github.com/Aryag1507/scamshield";

const STEPS = [
  {
    title: "Taught by a larger model",
    body: "A large teacher model wrote thousands of realistic modern scams (toll texts, fake recruiters, crypto \"wrong numbers\") and the real messages they imitate, and explained what gives each one away.",
  },
  {
    title: "Trained for one job",
    body: "A 0.5B-parameter language model was fully fine-tuned on that data, so it reads a message the way a fraud analyst would and explains its call in one sentence.",
  },
  {
    title: "Tuned not to cry wolf",
    body: "Its alarm threshold is calibrated so legitimate messages are rarely flagged. A warning that's usually wrong gets ignored.",
  },
];

const RESULTS = [
  { label: "Scams caught", before: "0%", after: "85%" },
  { label: "Scam types never seen in training, caught", before: "0%", after: "99%" },
  { label: "Ranking quality (AUC)", before: "0.51", after: "0.96" },
];

export default function Home() {
  return (
    <>
      <section className="pt-8 pb-8 sm:pt-16 sm:pb-10">
        <h1 className="text-[2.1rem] leading-[1.1] font-semibold tracking-tight text-balance sm:text-5xl">
          Is this message a scam?
        </h1>
        <p className="mt-4 max-w-xl text-lg text-pretty text-muted">
          Paste a text, email, or DM. Get a straight answer in seconds, with the warning signs spelled out.
        </p>
      </section>

      <Checker />

      <section id="how-it-works" className="scroll-mt-8 pt-24">
        <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
        <ol className="mt-6 grid gap-4 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="rounded-2xl border border-border bg-surface p-5">
              <span className="font-mono text-xs text-muted">0{i + 1}</span>
              <h3 className="mt-2 font-medium">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="pt-16">
        <h2 className="text-2xl font-semibold tracking-tight">Before and after training</h2>
        <p className="mt-2 text-sm text-muted">
          Same base model, measured on 362 held-out messages plus 115 scams from types it never trained on.
        </p>
        <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-normal sm:px-5"></th>
                <th scope="col" className="px-3 py-3 text-right font-normal">Untrained</th>
                <th scope="col" className="px-4 py-3 text-right font-normal sm:px-5">ScamShield</th>
              </tr>
            </thead>
            <tbody>
              {RESULTS.map((r) => (
                <tr key={r.label} className="border-b border-border last:border-0">
                  <th scope="row" className="px-4 py-3.5 font-normal sm:px-5">{r.label}</th>
                  <td className="px-3 py-3.5 text-right font-mono tabular-nums text-muted">{r.before}</td>
                  <td className="px-4 py-3.5 text-right font-mono font-medium tabular-nums text-safe sm:px-5">{r.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm text-muted">
          Model, data pipeline, and training code are open:{" "}
          <a href={HF_URL} className="text-accent hover:underline">model on Hugging Face</a>
          {" · "}
          <a href={GITHUB_URL} className="text-accent hover:underline">code on GitHub</a>
        </p>
      </section>
    </>
  );
}
