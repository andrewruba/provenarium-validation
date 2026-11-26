import { obligationSourceCatalog } from '../compiler.js';
import { manualReasonSchema, type Plan, type Urs } from '../schema.js';

/** The runtime's general browser capabilities, shared with protocol authoring. */
export const automationCapabilities = [
  {
    id: 'forms',
    actions: ['fill', 'select', 'click', 'upload', 'read'],
    description:
      'Enter values, inspect field attributes and validation messages, exercise boundaries, and assert calculated outputs.',
  },
  {
    id: 'tables',
    actions: ['read'],
    description:
      'Read complete ordered table rows and cells after browser updates, then compare exact expected values.',
  },
  {
    id: 'downloads',
    actions: ['download', 'observe_download'],
    description:
      'Inspect CSV rows, file bytes, browser-suggested filename and metadata, or assert that a click produces no download.',
  },
  {
    id: 'browser_contexts',
    actions: ['browser'],
    description:
      'Open or switch tabs and isolated browser profiles, and compare storage isolation and sharing.',
  },
  {
    id: 'browser_restart',
    actions: ['browser'],
    description:
      'Restart a persistent browser profile and verify retained state with executable assertions.',
  },
  {
    id: 'dialogs',
    actions: ['dialog'],
    description:
      'Accept or dismiss a confirmation dialog, retain its message, and verify resulting state.',
  },
  {
    id: 'storage_failure',
    actions: ['storage'],
    description:
      'Deny browser storage access, then verify failure handling and preservation of application state.',
  },
] as const;

/** These concrete browser tasks are capabilities, not external resources. */
function supportedBrowserWork(dependency: string): boolean {
  const normalized = dependency
    .toLowerCase()
    .replaceAll('_', ' ')
    .trim()
    .replace(
      /^(?:(?:inspect|check|verify|test|read|observe|assert|compare|exercise|perform|open|close|accept|dismiss|display|generate|create|view)\s+)?(?:(?:the|a|an)\s+)?/,
      '',
    )
    .replace(/^human[- ]readable\s+/, '');
  return (
    automationCapabilities.some(
      (capability) => capability.id.replaceAll('_', ' ') === normalized,
    ) ||
    /^(?:browser(?: (?:restart|tabs?|profiles?|contexts?|storage))?|persistent browser (?:profile|restart)|(?:csv|downloads?|files?|exports?)(?: (?:bytes?|contents?|filenames?|metadata|inspection|exports?|downloads?|display|output|rows?|cells?|absence|presence|availability)){0,3}|(?:csv|download) (?:filename and byte inspection)|(?:confirmation )?dialogs?|(?:local|session) ?storage|tables?(?: (?:rows?|cells?|contents?))?|forms?(?: (?:fields?|inputs?|validation))?|(?:calculation|validation|application|display) (?:results?|outputs?|values?|messages?|precision))(?:\s+(?:inspection|checks?|testing|automation|behavior|persistence|isolation|handling))?$/i.test(
      normalized,
    )
  );
}

/** Descriptive words such as human-readable and a user manual do not request human execution. */
function explicitManualActivity(quote: string): boolean {
  return (
    /\b(?:human|person)(?:\s+(?:reviewer|operator|inspector))?\s+(?:must|shall|is required to)\s+(?!(?:not|never)\b)\w+/i.test(
      quote,
    ) ||
    /(?<!no )(?<!not )\b(?:manual|human)\s+(?:inspection|review|verification|qualification|assessment|execution|measurement|testing|test|sign[- ]off)\b[^.!?;]{0,100}\b(?:is|are)\s+(?:required|mandatory)\b/i.test(
      quote,
    ) ||
    /\b(?:must|shall|is required to|are required to)\s+(?!(?:not|never)\b)(?:\w+\s+){0,5}manually\b/i.test(
      quote,
    ) ||
    /^\s*manually\s+(?:inspect|review|verify|qualify|assess|measure|test)\b/i.test(quote)
  );
}

export type AutomationPolicyOptions = { allowManual?: boolean };

/** Manual execution is an explicit, grounded exception, never an automatic fallback. */
export function auditAutomation(
  plan: Plan,
  urs: Urs,
  options: AutomationPolicyOptions = {},
): string[] {
  const sources = obligationSourceCatalog(urs);
  const issues: string[] = [];
  for (const c of plan.cases) {
    if (!c.manual) continue;
    if (!options.allowManual) {
      issues.push(
        `${c.id}: manual execution is not enabled. Convert this case to executable steps and transfer every manual obligation to its assertions; preserve the required behavior. Use --allow-manual only for an explicit URS-grounded exception.`,
      );
      continue;
    }
    const parsed = manualReasonSchema.safeParse(c.manual_reason);
    if (!parsed.success) {
      issues.push(
        `${c.id}: manual execution requires a structured manual_reason identifying an explicit requirement or external dependency with an exact requirement source and supporting quote.`,
      );
      continue;
    }
    const reason = parsed.data;
    if (!c.requirements.includes(reason.requirement_id))
      issues.push(
        `${c.id}: manual_reason.requirement_id must name a requirement covered by this case.`,
      );
    const source = sources.find(
      (item) => item.requirement_id === reason.requirement_id && item.source === reason.source,
    );
    const content =
      source &&
      (typeof source.content === 'string' ? source.content : JSON.stringify(source.content));
    if (!content || !content.includes(reason.supporting_quote))
      issues.push(
        `${c.id}: manual_reason.supporting_quote must occur exactly in the cited requirement source ${reason.source}.`,
      );
    if (!reason.supporting_quote.includes(reason.dependency))
      issues.push(
        `${c.id}: manual_reason.dependency must name the specific resource or activity verbatim in its supporting quote.`,
      );
    if (
      reason.kind === 'explicit_manual_requirement' &&
      !explicitManualActivity(reason.supporting_quote)
    )
      issues.push(
        `${c.id}: an explicit_manual_requirement must quote a requirement that explicitly calls for a manual or human activity.`,
      );
    if (reason.kind === 'external_dependency' && supportedBrowserWork(reason.dependency))
      issues.push(
        `${c.id}: ${reason.dependency} is supported browser automation, not an external dependency. Convert the case to executable steps.`,
      );
  }
  return issues;
}
