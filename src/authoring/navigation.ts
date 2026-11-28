import type { Plan } from '../schema.js';
import { assertAllowedUrl } from './security.js';

export function normalizeBlankNavigations(plan: Plan): void {
  const { url, allowed_origins: origins } = plan.target;
  const entry = new URL(assertAllowedUrl(url, url, origins));
  for (const testCase of plan.cases) {
    for (const step of testCase.steps) {
      for (const [index, action] of step.actions.entries()) {
        const next = step.actions[index + 1];
        if (action.op !== 'navigate' || action.url !== 'about:blank' || next?.op !== 'navigate')
          continue;

        let destination: URL;
        try {
          destination = new URL(assertAllowedUrl(next.url, url, origins));
        } catch {
          continue; // The plan validator still rejects an unsafe destination.
        }
        // A hash change alone can keep the current document alive. Keep the
        // reload check intact by using a different, already approved app page.
        if (
          entry.origin === destination.origin &&
          (entry.pathname !== destination.pathname || entry.search !== destination.search)
        )
          action.url = entry.href;
      }
    }
  }
}
