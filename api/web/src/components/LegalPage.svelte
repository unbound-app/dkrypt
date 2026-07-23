<script lang="ts">
  import PublicPageFooter from './PublicPageFooter.svelte';
  import PublicPageHeader from './PublicPageHeader.svelte';

  type LegalDocument = 'terms' | 'privacy' | 'refund';

  let { document }: { document: LegalDocument } = $props();
</script>

<div class="min-h-screen">
  <PublicPageHeader />
  <main class="mx-auto max-w-3xl px-5 py-12">
    {#if document === 'terms'}
      <article class="legal-document">
        <div class="text-accent mb-3 text-sm font-semibold tracking-wide uppercase">Legal</div>
        <h1>Terms of service</h1>
        <p class="document-date">Last updated: 23 July 2026</p>

        <p>
          These Terms of Service govern your access to and use of dkrypt. The service is offered as dkrypt (“dkrypt,” “we,” “us,” or
          “our”). By creating an account, accessing the service, or continuing to use it, you agree to these terms.
        </p>

        <h2>1. The service</h2>
        <p>
          dkrypt provides tools for managing authorized iOS application decryption workflows, including request queues, status tracking,
          downloadable results, and optional API access. Available features depend on your account permissions and subscription plan.
          Viewer accounts can inspect information made available to them but cannot submit decrypt requests or use the API.
        </p>

        <h2>2. Accounts and eligibility</h2>
        <p>
          You must be legally capable of entering into a binding agreement and must provide accurate account information. Accounts may be
          created through supported identity providers such as GitHub or Discord. You are responsible for protecting your account, API
          keys, and devices and for activity performed through them. Notify us promptly if you suspect unauthorized access.
        </p>

        <h2>3. Acceptable use</h2>
        <p>You may use dkrypt only for lawful, authorized purposes. You must not:</p>
        <ul>
          <li>process, access, copy, or distribute software or data unless you have the rights and authorization to do so;</li>
          <li>infringe intellectual property, privacy, publicity, contractual, or other third-party rights;</li>
          <li>use the service for fraud, spam, harassment, malware, abuse, or other unlawful conduct;</li>
          <li>probe, scan, scrape, overload, bypass, or interfere with service security, access controls, rate limits, or infrastructure;</li>
          <li>share credentials or API keys in a way that enables unauthorized access; or</li>
          <li>misrepresent your identity, affiliation, authority, or intended use.</li>
        </ul>
        <p>
          You are responsible for complying with applicable laws, software licenses, platform rules, and any terms governing content you
          submit or access.
        </p>

        <h2>4. Subscriptions, payments, and taxes</h2>
        <p>
          Paid plans are monthly subscriptions that renew automatically until canceled. The applicable plan, billing frequency, price, and
          taxes are presented before purchase. Paddle is our authorized reseller and merchant of record. Paddle processes payments, issues
          receipts, calculates applicable taxes, and administers subscription billing under the
          <a href="https://www.paddle.com/legal/buyer-terms" target="_blank" rel="noopener noreferrer">Paddle Buyer Terms</a>.
        </p>
        <p>
          You may cancel through the dkrypt billing portal or the link in your Paddle receipt. Unless mandatory law provides otherwise,
          cancellation takes effect at the end of the current billing period. Plan changes may be prorated as shown before confirmation.
          Access to paid features depends on the subscription remaining in an eligible status.
        </p>

        <h2>5. Refunds</h2>
        <p>
          Refund eligibility and requests are governed by our <a href="/refund-policy">Refund Policy</a> and Paddle’s applicable buyer
          terms. Nothing in these terms limits mandatory consumer rights.
        </p>

        <h2>6. Intellectual property</h2>
        <p>
          We and our licensors retain all rights in the service, software, documentation, design, branding, and related materials. The
          public source-code license, where applicable, governs rights to copy, modify, or distribute code and does not grant rights to
          service accounts, infrastructure, trademarks, or third-party content. You retain rights in content you lawfully submit and grant
          us the limited rights needed to process it and provide the service.
        </p>

        <h2>7. Third-party services</h2>
        <p>
          dkrypt interoperates with third-party services including GitHub, Discord, Apple services, Paddle, and infrastructure providers.
          Their own terms and privacy notices apply to their services. We are not responsible for third-party availability or acts beyond
          our reasonable control.
        </p>

        <h2>8. Suspension and termination</h2>
        <p>
          We may restrict, suspend, or terminate access for a material breach, non-payment, fraud or security risk, unlawful activity, or
          repeated or serious violations. Where appropriate, we will provide notice and a reasonable opportunity to remedy the issue.
          You may stop using the service and cancel your subscription at any time.
        </p>

        <h2>9. Service availability and changes</h2>
        <p>
          The service is provided on an “as available” basis. We do not guarantee uninterrupted, error-free, or permanently available
          operation. Features may change, and maintenance, capacity, upstream failures, or security events may affect availability.
        </p>

        <h2>10. Disclaimers and liability</h2>
        <p>
          To the fullest extent permitted by law, we disclaim implied warranties and are not liable for indirect, incidental, special,
          consequential, or business losses arising from use of the service. Our aggregate liability relating to the service will not exceed
          the amount you paid for dkrypt during the six months before the event giving rise to the claim. These limitations do not apply
          where exclusion or limitation is prohibited by law, including liability for fraud, willful misconduct, or mandatory consumer
          rights.
        </p>

        <h2>11. Changes to these terms</h2>
        <p>
          We may update these terms to reflect service, legal, or operational changes. We will post the revised version and update its date.
          Where required, we will provide additional notice. Continued use after an update takes effect constitutes acceptance to the
          extent permitted by law.
        </p>

        <h2>12. Contact</h2>
        <p>
          Questions about these terms may be submitted through the <a href="/contact">dkrypt contact page</a>. Billing questions may also
          be submitted through
          <a href="https://paddle.net" target="_blank" rel="noopener noreferrer">Paddle Buyer Support</a>.
        </p>
      </article>
    {:else if document === 'privacy'}
      <article class="legal-document">
        <div class="text-accent mb-3 text-sm font-semibold tracking-wide uppercase">Legal</div>
        <h1>Privacy notice</h1>
        <p class="document-date">Last updated: 23 July 2026</p>

        <p>
          This notice explains how dkrypt (“we,” “us,” or “our”) handles personal data when you visit or use the service. For questions or
          privacy requests, use the <a href="/contact">dkrypt contact page</a>.
        </p>

        <h2>1. Data we collect</h2>
        <ul>
          <li>
            <strong>Account data:</strong> identity-provider user ID, username, display name, email address, avatar, and provider name from
            GitHub or Discord.
          </li>
          <li>
            <strong>Billing data:</strong> Paddle customer and subscription identifiers, plan, subscription status, renewal information,
            and billing email. Paddle collects and processes payment details; dkrypt does not store full card details.
          </li>
          <li>
            <strong>Service data:</strong> decrypt requests, application identifiers and versions, job status, results, API-key metadata,
            preferences, notifications, and support communications.
          </li>
          <li>
            <strong>Technical and security data:</strong> session identifiers, timestamps, request and audit records, device or browser
            information made available through standard web requests, and information needed to detect abuse or diagnose faults.
          </li>
        </ul>

        <h2>2. How we use data</h2>
        <p>We use personal data to:</p>
        <ul>
          <li>authenticate users and provide requested service features;</li>
          <li>process subscriptions, maintain entitlements, and provide billing support;</li>
          <li>operate queues, API access, notifications, support, backups, and service administration;</li>
          <li>secure the service, prevent fraud and abuse, enforce our terms, and investigate incidents;</li>
          <li>diagnose errors, maintain reliability, and improve the service; and</li>
          <li>comply with legal, tax, accounting, and regulatory obligations.</li>
        </ul>

        <h2>3. Legal bases</h2>
        <p>
          Where data-protection law requires a legal basis, we rely on performance of our contract with you, our legitimate interests in
          operating and securing the service, compliance with legal obligations, and consent where specifically requested. You may withdraw
          consent at any time, without affecting earlier lawful processing.
        </p>

        <h2>4. Sharing and processors</h2>
        <p>We share data only as needed with:</p>
        <ul>
          <li>GitHub or Discord for authentication you choose to use;</li>
          <li>Paddle, our merchant of record, for checkout, subscription administration, tax, receipts, fraud prevention, and refunds;</li>
          <li>hosting, network, security, email, notification, and infrastructure providers that help operate dkrypt;</li>
          <li>Apple and related services where required to fulfill an authorized request; and</li>
          <li>authorities or professional advisers where required by law or necessary to protect legal rights and safety.</li>
        </ul>
        <p>
          Paddle handles buyer data under its own
          <a href="https://www.paddle.com/legal/privacy" target="_blank" rel="noopener noreferrer">Privacy Notice</a>.
          We do not sell personal data or use it for third-party behavioral advertising.
        </p>

        <h2>5. Cookies and local storage</h2>
        <p>
          dkrypt uses an essential session cookie to keep you signed in and browser storage for interface preferences and service-worker
          functionality. These technologies are necessary to provide requested features. We do not use advertising cookies or third-party
          analytics cookies.
        </p>

        <h2>6. Retention</h2>
        <p>
          We retain account, billing, operational, and security data only for as long as needed for the purposes described above, including
          while your account is active and as required for legal, accounting, dispute, security, and backup obligations. Retention periods
          vary by data type. Data may remain in protected backups until the applicable backup cycle expires.
        </p>

        <h2>7. International transfers</h2>
        <p>
          Providers may process data in countries other than your own. Where required, we and our providers use recognized transfer
          safeguards. Local laws in a destination country may permit access by public authorities.
        </p>

        <h2>8. Security</h2>
        <p>
          We use technical and organizational safeguards intended to protect personal data, including access controls, signed sessions,
          restricted secrets, and encrypted transport. No system is completely secure, so we cannot guarantee absolute security.
        </p>

        <h2>9. Your rights</h2>
        <p>
          Depending on your location, you may have rights to access, correct, delete, restrict, object to, or obtain a portable copy of your
          personal data, withdraw consent, and complain to a supervisory authority. Use the <a href="/contact">dkrypt contact page</a> to
          make a request. We may need to verify your identity.
        </p>

        <h2>10. Children</h2>
        <p>
          dkrypt is not directed to children under 16, and we do not knowingly collect their personal data. Contact us if you believe a child
          has provided personal data.
        </p>

        <h2>11. Changes to this notice</h2>
        <p>
          We may update this notice to reflect service, legal, or operational changes. The current version and its effective date will
          remain available on this page.
        </p>
      </article>
    {:else}
      <article class="legal-document">
        <div class="text-accent mb-3 text-sm font-semibold tracking-wide uppercase">Legal</div>
        <h1>Refund policy</h1>
        <p class="document-date">Last updated: 23 July 2026</p>

        <p>
          Paddle is the authorized reseller and merchant of record for dkrypt subscriptions. Paddle handles payments, receipts,
          cancellations, and refund processing. This policy supplements and refers to the
          <a href="https://www.paddle.com/legal/refund-policy" target="_blank" rel="noopener noreferrer">Paddle Refund Policy</a>,
          which governs eligibility and processing.
        </p>

        <h2>1. Refund period</h2>
        <p>
          You may request a refund within 14 days of a transaction. Requests are assessed under Paddle’s Refund Policy and applicable law.
          Submitting a request does not guarantee approval, except where you have a mandatory statutory right to a refund or withdrawal.
          Nothing in this policy limits non-waivable consumer rights.
        </p>

        <h2>2. How to request a refund</h2>
        <p>Use one of these methods:</p>
        <ul>
          <li>select the manage-subscription or support link in your Paddle receipt or transaction email;</li>
          <li>open the dkrypt billing portal and follow the available support options; or</li>
          <li>visit <a href="https://paddle.net" target="_blank" rel="noopener noreferrer">Paddle Buyer Support</a> and choose the refund option.</li>
        </ul>
        <p>
          Include the email address used for purchase and enough transaction information for Paddle to locate the payment. Do not send full
          card details to dkrypt.
        </p>

        <h2>3. Technical problems and non-delivery</h2>
        <p>
          If a persistent technical defect prevents access to paid features, use the <a href="/contact">dkrypt contact page</a> so we can
          try to resolve it. If the issue cannot be resolved, request a refund through Paddle and describe the problem.
        </p>

        <h2>4. Cancellations</h2>
        <p>
          You can cancel a subscription at any time through the dkrypt billing portal or the link in your Paddle receipt. Cancellation
          normally takes effect at the end of the current billing period and prevents future renewal charges. Cancellation by itself does
          not automatically refund a completed payment.
        </p>

        <h2>5. Processing and access</h2>
        <p>
          Approved refunds are generally returned to the original payment method. Processing and bank settlement times vary. If a
          transaction is refunded, access to the associated paid plan may end. Partial refunds may result in a corresponding adjustment to
          paid access.
        </p>

        <h2>6. Contact</h2>
        <p>
          For product support, use the <a href="/contact">dkrypt contact page</a>. For refund status or payment questions, contact
          <a href="https://paddle.net" target="_blank" rel="noopener noreferrer">Paddle Buyer Support</a>.
        </p>
      </article>
    {/if}
  </main>
  <PublicPageFooter />
</div>
