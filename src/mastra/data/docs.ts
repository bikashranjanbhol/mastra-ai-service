/**
 * The internal documentation corpus the docs agent answers over.
 *
 * Kept in-process deliberately: it is small, deterministic and makes the
 * cross-provider benchmark reproducible (the same query returns the same
 * passages on every provider, so differences in the table are model
 * differences, not retrieval noise).
 *
 * Swapping this for a real vector store is a change to `tools/search-docs.ts`
 * only — agents and workflows call the tool, never this module.
 */

export interface DocChunk {
  readonly id: string;
  readonly title: string;
  readonly section: string;
  /** Owning team, used by triage to route follow-up work. */
  readonly owner: string;
  readonly text: string;
  readonly keywords: readonly string[];
}

export const DOC_CHUNKS: readonly DocChunk[] = [
  {
    id: 'onboarding-001',
    title: 'Employee Onboarding',
    section: 'Laptop provisioning',
    owner: 'it-support',
    text:
      'New hires are issued a laptop on their first day. IT ships hardware to the address on file five business days ' +
      'before the start date. If a laptop has not arrived by the start date, the new hire should be issued a loaner ' +
      'from the local office pool and a replacement order raised the same day.',
    keywords: ['laptop', 'hardware', 'onboarding', 'new hire', 'provisioning', 'loaner'],
  },
  {
    id: 'onboarding-002',
    title: 'Employee Onboarding',
    section: 'Account access',
    owner: 'it-support',
    text:
      'Identity accounts are created automatically from the HR record 24 hours before the start date. Access to ' +
      'production systems is never granted automatically; it requires an access request approved by the owning team ' +
      'lead. Requests are reviewed twice daily at 10:00 and 16:00 UTC.',
    keywords: ['account', 'access', 'sso', 'identity', 'production', 'approval', 'permissions'],
  },
  {
    id: 'expenses-001',
    title: 'Expense Policy',
    section: 'Reimbursement limits',
    owner: 'finance',
    text:
      'Meals during travel are reimbursed up to 75 USD per day. Receipts are required for any single expense above ' +
      '25 USD. Expenses submitted more than 60 days after they were incurred require director approval and are ' +
      'rejected by default.',
    keywords: ['expense', 'reimbursement', 'meals', 'receipt', 'travel', 'limit', 'per diem'],
  },
  {
    id: 'expenses-002',
    title: 'Expense Policy',
    section: 'Software purchases',
    owner: 'finance',
    text:
      'Software and SaaS subscriptions are not reimbursable as personal expenses. They must be purchased through ' +
      'the procurement process so that spend is tracked against the department budget. Any recurring subscription ' +
      'above 500 USD per year additionally requires a security review before purchase.',
    keywords: ['software', 'saas', 'subscription', 'procurement', 'purchase', 'security review', 'budget'],
  },
  {
    id: 'incident-001',
    title: 'Incident Response',
    section: 'Severity levels',
    owner: 'platform',
    text:
      'SEV1 means complete loss of a customer-facing service or confirmed data loss; it pages the on-call engineer ' +
      'immediately and requires an incident commander. SEV2 is major degradation with a workaround available. SEV3 ' +
      'covers minor issues with no customer impact and is handled during business hours.',
    keywords: ['incident', 'severity', 'sev1', 'sev2', 'sev3', 'outage', 'on-call', 'paging'],
  },
  {
    id: 'incident-002',
    title: 'Incident Response',
    section: 'Postmortems',
    owner: 'platform',
    text:
      'Every SEV1 and SEV2 requires a written postmortem within five business days. Postmortems are blameless and ' +
      'must list contributing factors, the detection gap, and concrete action items with named owners. Action items ' +
      'without an owner are not accepted.',
    keywords: ['postmortem', 'retrospective', 'blameless', 'action items', 'incident', 'review'],
  },
  {
    id: 'security-001',
    title: 'Security Standards',
    section: 'Credential handling',
    owner: 'security',
    text:
      'Secrets are never committed to source control. All credentials live in the managed secret store and are ' +
      'injected at deploy time as environment variables. A credential found in a repository must be rotated within ' +
      'one hour of discovery, regardless of whether the repository is private.',
    keywords: ['secret', 'credential', 'api key', 'rotation', 'source control', 'env var', 'leak'],
  },
  {
    id: 'security-002',
    title: 'Security Standards',
    section: 'Data retention',
    owner: 'security',
    text:
      'Customer data is retained for 24 months after account closure, then deleted. Aggregated and anonymised ' +
      'analytics may be retained indefinitely. Deletion requests from customers are honoured within 30 days and ' +
      'take precedence over the standard retention window.',
    keywords: ['retention', 'deletion', 'customer data', 'gdpr', 'privacy', 'anonymised'],
  },
  {
    id: 'support-001',
    title: 'Support Handbook',
    section: 'Response targets',
    owner: 'support',
    text:
      'First response targets by plan: Enterprise one hour, Business four hours, Starter one business day. The ' +
      'clock starts when the ticket is created, not when it is assigned. Targets apply during the customer local ' +
      'business hours except for Enterprise, which is 24/7.',
    keywords: ['sla', 'response time', 'support', 'enterprise', 'business', 'starter', 'ticket', 'target'],
  },
  {
    id: 'support-002',
    title: 'Support Handbook',
    section: 'Escalation path',
    owner: 'support',
    text:
      'Support escalates to engineering when a ticket is reproducible and traced to a defect, or when a customer on ' +
      'an Enterprise plan reports a service interruption. Escalations must include reproduction steps and the ' +
      'affected account id, otherwise engineering will return the ticket to support.',
    keywords: ['escalation', 'engineering', 'reproduce', 'defect', 'account id', 'interruption'],
  },
];

/** Distinct owning teams — used by triage as the routing vocabulary. */
export const DOC_OWNERS = [...new Set(DOC_CHUNKS.map((c) => c.owner))].sort();
