import { Link } from "react-router-dom";

export function TermsPage() {
  return (
    <section className="legal-page">
      <div className="legal-page__container">
        <header className="legal-page__header">
          <span className="eyebrow">Legal</span>
          <h1>Terms of Service</h1>
          <p className="legal-page__updated">Last updated: May 2, 2026</p>
        </header>

        <article className="legal-page__content">
          <section>
            <h2>1. Acceptance of Terms</h2>
            <p>
              By accessing or using <strong>SkillSpark</strong> ("the Platform"), accessible at{" "}
              <a href="https://skillspark.study" target="_blank" rel="noopener noreferrer">
                skillspark.study
              </a>
              , you agree to be bound by these Terms of Service. If you do not agree to these terms,
              please do not use the Platform.
            </p>
          </section>

          <section>
            <h2>2. Description of Service</h2>
            <p>
              SkillSpark is an educational platform that provides interactive accounting journal
              entry practice and assessment. The Platform includes:
            </p>
            <ul>
              <li>Timed quiz sessions with instant evaluation.</li>
              <li>Score tracking and performance history.</li>
              <li>Administrative tools for managing students, questions, and settings.</li>
            </ul>
          </section>

          <section>
            <h2>3. User Accounts</h2>
            <h3>3.1 Authentication</h3>
            <p>
              Access to the Platform requires authentication via Google Sign-In. By signing in, you
              authorise us to receive your name and email address from Google for account management
              purposes.
            </p>

            <h3>3.2 Student Access</h3>
            <p>
              Student access is granted by platform administrators. Administrators may approve,
              modify, or revoke student access at any time.
            </p>

            <h3>3.3 Account Responsibility</h3>
            <p>
              You are responsible for all activity that occurs under your account. Do not share your
              login credentials or allow others to access your account.
            </p>
          </section>

          <section>
            <h2>4. Acceptable Use</h2>
            <p>You agree not to:</p>
            <ul>
              <li>Use the Platform for any unlawful purpose.</li>
              <li>Attempt to gain unauthorised access to any part of the Platform.</li>
              <li>Interfere with or disrupt the Platform's infrastructure.</li>
              <li>Submit false or misleading information.</li>
              <li>Use automated tools or scripts to access the Platform without permission.</li>
            </ul>
          </section>

          <section>
            <h2>5. Intellectual Property</h2>
            <p>
              All content on the Platform, including questions, interface design, and branding, is
              the property of SkillSpark or its content contributors. You may not reproduce,
              distribute, or create derivative works from this content without explicit permission.
            </p>
          </section>

          <section>
            <h2>6. Quiz and Assessment Rules</h2>
            <ul>
              <li>Quiz sessions are timed. Once started, the timer cannot be paused or extended.</li>
              <li>Submissions after the time limit will not be accepted.</li>
              <li>Scores are calculated automatically and are final.</li>
              <li>Administrators may adjust quiz settings (question count, time limits) at any time.</li>
            </ul>
          </section>

          <section>
            <h2>7. Limitation of Liability</h2>
            <p>
              The Platform is provided "as is" without warranties of any kind. We are not liable for
              any damages arising from your use of the Platform, including but not limited to data
              loss, service interruptions, or inaccurate quiz evaluations.
            </p>
          </section>

          <section>
            <h2>8. Termination</h2>
            <p>
              We reserve the right to suspend or terminate your access to the Platform at any time,
              with or without cause, and with or without notice. Upon termination, your right to use
              the Platform ceases immediately.
            </p>
          </section>

          <section>
            <h2>9. Changes to Terms</h2>
            <p>
              We may modify these Terms of Service at any time. Continued use of the Platform after
              changes constitutes acceptance of the updated terms.
            </p>
          </section>

          <section>
            <h2>10. Contact</h2>
            <p>
              For questions about these Terms of Service, contact us at:{" "}
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
