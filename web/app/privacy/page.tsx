import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy · ScamShield" };

export default function Privacy() {
  return (
    <article className="max-w-2xl pt-8 pb-8 sm:pt-16">
      <h1 className="text-3xl font-semibold tracking-tight">Privacy</h1>
      <p className="mt-2 text-sm text-muted">Last updated October 17, 2026</p>

      <div className="mt-8 space-y-6 leading-relaxed">
        <section>
          <h2 className="font-medium">What happens to a message you check</h2>
          <p className="mt-2 text-muted">
            The message is sent over HTTPS to the ScamShield server, analyzed in memory by the model, and discarded.
            It is never written to disk, logged, or used for training. To answer repeat checks faster, the server keeps
            a short-lived, in-memory cache keyed by a one-way hash of the message. The cache holds the verdict and
            the generated explanation (which may quote a detail such as a link), never the message itself, and is
            cleared when the server restarts.
          </p>
        </section>
        <section>
          <h2 className="font-medium">What is logged</h2>
          <p className="mt-2 text-muted">
            Operational data only: the channel you picked, the message length, the verdict, and how long the check
            took. Your IP address is held in memory for about a minute to enforce a rate limit.
          </p>
        </section>
        <section>
          <h2 className="font-medium">No accounts, no tracking</h2>
          <p className="mt-2 text-muted">ScamShield has no accounts, no ads, and no third-party analytics.</p>
        </section>
        <section>
          <h2 className="font-medium">Questions</h2>
          <p className="mt-2 text-muted">
            Open an issue on{" "}
            <a href="https://github.com/Aryag1507/scamshield" className="text-accent hover:underline">GitHub</a>.
          </p>
        </section>
      </div>
    </article>
  );
}
