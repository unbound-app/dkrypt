const contactAddress = 'contact<span>@</span>dylib.dev';

const navigation = `
  <nav aria-label="Public pages">
    <a href="/pricing">Pricing</a>
    <a href="/terms">Terms</a>
    <a href="/privacy">Privacy</a>
    <a href="/refund-policy">Refund policy</a>
    <a href="/contact">Contact</a>
  </nav>
`;

const footer = `
  <footer>
    ${navigation}
    <p>${contactAddress}</p>
  </footer>
`;

const pageContent: Record<string, string> = {
  '/': `
    <main>
      <h1>dkrypt</h1>
      <p>dkrypt is a subscription service for authorized iOS application decryption workflows, request tracking, downloadable results, and optional API access.</p>
      <p>Monthly plans start at €5. Every account begins with viewer access.</p>
      <p><a href="/pricing">View pricing</a> or <a href="/#sign-in">sign in</a>.</p>
    </main>
  `,
  '/pricing': `
    <main>
      <h1>dkrypt pricing</h1>
      <p>All plans renew monthly until canceled. Prices are shown in EUR, and applicable tax is calculated at checkout.</p>
      <section>
        <h2>Regular — €5/month</h2>
        <p>Dashboard decrypt access with standard queue priority.</p>
        <h2>Priority — €10/month</h2>
        <p>Dashboard decrypt access with high queue priority.</p>
        <h2>API — €15/month</h2>
        <p>Dashboard decrypts and API key access with standard queue priority.</p>
        <h2>Priority API — €20/month</h2>
        <p>Dashboard decrypts and API key access with high queue priority.</p>
      </section>
      <p><a href="/#sign-in">Sign in to subscribe</a>.</p>
    </main>
  `,
  '/terms': `
    <main>
      <article>
        <h1>Terms of service</h1>
        <p>Last updated: 23 July 2026</p>
        <p>These Terms of Service govern access to and use of dkrypt. By creating an account, accessing the service, or continuing to use it, you agree to these terms.</p>
        <h2>The service</h2>
        <p>dkrypt provides tools for managing authorized iOS application decryption workflows, including request queues, status tracking, downloadable results, and optional API access. Available features depend on account permissions and subscription plan.</p>
        <h2>Accounts and acceptable use</h2>
        <p>You must provide accurate account information, protect your account and API keys, and use dkrypt only for lawful purposes involving software and data you have the rights and authorization to process. You must not infringe third-party rights, distribute malware, commit fraud, bypass security controls, overload the service, or enable unauthorized access.</p>
        <h2>Subscriptions, payments, and taxes</h2>
        <p>Paid plans renew monthly until canceled. The plan, billing frequency, price, and taxes are presented before purchase. Paddle is the authorized reseller and merchant of record for dkrypt. Paddle processes payments, receipts, taxes, subscription billing, and buyer support under the <a href="https://www.paddle.com/legal/buyer-terms">Paddle Buyer Terms</a>.</p>
        <h2>Cancellation and refunds</h2>
        <p>You may cancel through the billing portal or the link in your purchase receipt. Cancellation normally takes effect at the end of the current billing period. Refund requests are governed by the <a href="/refund-policy">Refund Policy</a> and mandatory consumer law.</p>
        <h2>Service availability and liability</h2>
        <p>The service is provided on an as-available basis and may change or experience interruptions. To the fullest extent permitted by law, implied warranties are disclaimed and aggregate liability will not exceed the amount paid for dkrypt during the six months before the event giving rise to the claim.</p>
        <h2>Contact</h2>
        <p>Questions about these terms may be sent to ${contactAddress}.</p>
      </article>
    </main>
  `,
  '/privacy': `
    <main>
      <article>
        <h1>Privacy notice</h1>
        <p>Last updated: 23 July 2026</p>
        <p>This notice explains how dkrypt handles personal data. Privacy requests may be sent to ${contactAddress}.</p>
        <h2>Data collected</h2>
        <p>dkrypt processes identity-provider account details, billing and subscription identifiers, service requests and results, API-key metadata, preferences, support communications, session identifiers, timestamps, request records, and security audit data. Paddle processes payment details and dkrypt does not store full card details.</p>
        <h2>How data is used</h2>
        <p>Data is used to authenticate users, provide requested features, administer subscriptions and entitlements, operate queues and notifications, provide support, secure the service, prevent abuse, diagnose faults, and meet legal obligations.</p>
        <h2>Sharing and processors</h2>
        <p>Data is shared only as needed with GitHub or Discord for authentication, Paddle for payment and subscription administration, infrastructure providers, Apple services needed to fulfill authorized requests, and authorities where required by law. Personal data is not sold or used for third-party behavioral advertising.</p>
        <h2>Cookies, retention, and security</h2>
        <p>dkrypt uses an essential session cookie and browser storage for interface preferences. Data is retained only as long as needed for service, legal, accounting, dispute, security, and backup obligations. Technical and organizational safeguards include access controls, signed sessions, restricted secrets, and encrypted transport.</p>
        <h2>Your rights</h2>
        <p>Depending on location, users may have rights to access, correct, delete, restrict, object to, or obtain a portable copy of personal data, withdraw consent, and complain to a supervisory authority. Requests may be sent to ${contactAddress}.</p>
      </article>
    </main>
  `,
  '/refund-policy': `
    <main>
      <article>
        <h1>Refund policy</h1>
        <p>Last updated: 23 July 2026</p>
        <p>Paddle is the authorized reseller and merchant of record for dkrypt subscriptions. Paddle handles payments, receipts, cancellations, and refund processing under the <a href="https://www.paddle.com/legal/refund-policy">Paddle Refund Policy</a>.</p>
        <h2>Refund period</h2>
        <p>You may request a refund within 14 days of a transaction. Requests are assessed under Paddle's policy and applicable law. Nothing in this policy limits mandatory consumer rights.</p>
        <h2>How to request a refund</h2>
        <p>Use the manage-subscription or support link in your purchase receipt, open the dkrypt billing portal, or visit <a href="https://paddle.net">Paddle Buyer Support</a>. Include the purchase email and enough transaction information to locate the payment.</p>
        <h2>Technical problems and cancellations</h2>
        <p>For persistent technical defects, contact ${contactAddress}. Subscriptions can be canceled at any time through the billing portal or receipt link. Cancellation prevents future renewals but does not automatically refund a completed payment.</p>
        <h2>Processing</h2>
        <p>Approved refunds are generally returned to the original payment method. Processing times vary, and paid access may end when a transaction is refunded.</p>
      </article>
    </main>
  `,
  '/contact': `
    <main>
      <h1>Contact dkrypt</h1>
      <p>For product, account, service, security, or privacy questions, email ${contactAddress}.</p>
      <p>For billing and refund questions, use the manage-subscription link in your purchase receipt or visit <a href="https://paddle.net">Paddle Buyer Support</a>.</p>
    </main>
  `,
};

export function renderPublicPage(indexHtml: string, pathname: string): string {
  const content = pageContent[pathname] ?? pageContent['/'];
  const fallback = `
    <div data-app-fallback style="max-width: 880px; margin: 0 auto; padding: 48px 24px; font-family: system-ui, sans-serif; line-height: 1.6;">
      <header><a href="/"><strong>dkrypt</strong></a>${navigation}</header>
      ${content}
      ${footer}
    </div>
  `;
  return indexHtml.replace('<div id="app-root"></div>', `<div id="app-root">${fallback}</div>`);
}
