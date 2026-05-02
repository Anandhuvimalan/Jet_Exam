import { Link } from "react-router-dom";

export function PrivacyPage() {
  return (
    <section className="legal-page">
      <div className="legal-page__container">
        <header className="legal-page__header">
          <span className="eyebrow">Legal</span>
          <h1>Privacy Policy</h1>
          <p className="legal-page__updated">Last updated: May 2, 2026</p>
        </header>

        <article className="legal-page__content">
          <section>
            <h2>1. Introduction</h2>
            <p>
              Welcome to <strong>SkillSpark</strong> ("we", "us", or "our"), accessible at{" "}
              <a href="https://skillspark.study" target="_blank" rel="noopener noreferrer">
                skillspark.study
              </a>
              . We are committed to protecting your personal information and your right to privacy.
              This Privacy Policy explains what information we collect, how we use it, and what rights
              you have in relation to it.
            </p>
          </section>

          <section>
            <h2>2. Information We Collect</h2>
            <h3>2.1 Information provided via Google Sign-In</h3>
            <p>When you sign in using Google, we receive:</p>
            <ul>
              <li><strong>Name</strong> – your display name from your Google account.</li>
              <li><strong>Email address</strong> – used to identify your account and grant access.</li>
            </ul>
            <p>
              We do <strong>not</strong> access your Google Drive, contacts, photos, or any other
              Google service data.
            </p>

            <h3>2.2 Quiz and assessment data</h3>
            <p>We store your quiz submissions, scores, and performance history to provide feedback and track progress.</p>

            <h3>2.3 Technical data</h3>
            <p>
              We automatically collect minimal technical data including your IP address, browser type,
              and request timestamps for security and rate-limiting purposes. We do not use tracking
              cookies or third-party analytics.
            </p>
          </section>

          <section>
            <h2>3. How We Use Your Information</h2>
            <ul>
              <li>To authenticate your identity and manage your session.</li>
              <li>To provide personalised quiz experiences and score tracking.</li>
              <li>To allow administrators to manage student access and review results.</li>
              <li>To protect against abuse and enforce rate limits.</li>
            </ul>
          </section>

          <section>
            <h2>4. Data Storage and Security</h2>
            <p>
              Your data is stored securely in a PostgreSQL database hosted on a cloud infrastructure
              provider. We use encrypted connections and follow security best practices to protect
              your information.
            </p>
          </section>

          <section>
            <h2>5. Data Sharing</h2>
            <p>
              We do <strong>not</strong> sell, trade, or share your personal information with any
              third parties. Your data is only accessible to:
            </p>
            <ul>
              <li>You (your own account data and scores).</li>
              <li>Platform administrators (for managing student access and reviewing results).</li>
            </ul>
          </section>

          <section>
            <h2>6. Data Retention</h2>
            <p>
              We retain your account data and quiz history for as long as your account is active.
              If an administrator removes your account, all associated data is permanently deleted.
            </p>
          </section>

          <section>
            <h2>7. Your Rights</h2>
            <p>You have the right to:</p>
            <ul>
              <li>Access the personal data we hold about you.</li>
              <li>Request correction of inaccurate data.</li>
              <li>Request deletion of your account and associated data.</li>
            </ul>
            <p>
              To exercise these rights, contact us at{" "}
              <a href="mailto:anandhu7833@gmail.com">anandhu7833@gmail.com</a>.
            </p>
          </section>

          <section>
            <h2>8. Children's Privacy</h2>
            <p>
              SkillSpark is designed for educational use by students under institutional supervision.
              We do not knowingly collect data from children under 13 without parental or
              institutional consent.
            </p>
          </section>

          <section>
            <h2>9. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. Changes will be reflected on this
              page with an updated "Last updated" date.
            </p>
          </section>

          <section>
            <h2>10. Contact Us</h2>
            <p>
              If you have questions or concerns about this Privacy Policy, please contact us at:{" "}
              <a href="mailto:anandhu7833@gmail.com">anandhu7833@gmail.com</a>
            </p>
          </section>
        </article>

        <footer className="legal-page__footer">
          <Link to="/" className="button button--ghost">
            ← Back to SkillSpark
          </Link>
        </footer>
      </div>
    </section>
  );
}
