import type { LocatorSpec } from './schema.js';

// Only accept a literal role attribute, optionally under a literal ID. Other
// accessible names and CSS constructs require human judgment.
const literalRoleSelector =
  /^(?:#[A-Za-z_][A-Za-z0-9_-]*[ \t]+)?\[role=(?:"([a-z][a-z0-9-]*)"|'([a-z][a-z0-9-]*)'|([a-z][a-z0-9-]*))\]$/;

/** A possible replacement. The browser must still prove it resolves uniquely. */
export function misplacedRoleSelector(locator: LocatorSpec): LocatorSpec | undefined {
  if (locator.by !== 'role' || locator.match) return;
  const match = literalRoleSelector.exec(locator.value);
  if (!match || (match[1] ?? match[2] ?? match[3]) !== locator.role) return;
  return { by: 'css', value: locator.value, exact: true };
}

/** Live message roles are often unnamed, even when their content is visible. */
export function misplacedRoleText(locator: LocatorSpec): LocatorSpec | undefined {
  if (
    locator.by !== 'role' ||
    locator.match ||
    (locator.role !== 'alert' && locator.role !== 'status') ||
    misplacedRoleSelector(locator)
  )
    return;
  return { ...locator, match: 'text' };
}
