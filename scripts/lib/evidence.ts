/**
 * Parser for the HashScan links in docs/EVIDENCE.md and README.md.
 *
 * Pure functions only (no network): `scripts/verify-evidence.ts` queries the mirror node for what is found here.
 */

export type LinkKind = "transaction" | "contract" | "account" | "topic" | "token" | "schedule";

/** What the mirror node must report for a transaction link. */
export type Expectation =
  | { type: "success" }
  /** A proof that something fails: any non-SUCCESS result, or exactly `status` when the text names one. */
  | { type: "failure"; status?: string };

export interface EvidenceLink {
  file: string;
  line: number;
  url: string;
  kind: LinkKind;
  /** Entity id as the mirror node wants it (transaction ids as `0.0.X-seconds-nanos`, contracts as `0x...`). */
  id: string;
  /** In an archived or first-deployment section: a failure is reported but does not fail the run. */
  archived: boolean;
  expect: Expectation;
}

/** A TODO or "pending demo run" marker left in the docs for evidence that does not exist yet. */
export interface PendingMarker {
  file: string;
  line: number;
  text: string;
}

const LINK_RE = /https:\/\/hashscan\.io\/testnet\/(transaction|contract|account|topic|token|schedule)\/([A-Za-z0-9.@\-_]+)/g;
const STATUS_RE = /\b(CONTRACT_REVERT_EXECUTED|NO_SCHEDULING_ALLOWED_AFTER_SCHEDULED_RECURSION)\b/;
const FAILURE_WORD_RE = /\b(reverts?|reverted|rejections?|rejected|failed)\b/i;
/** A Solidity custom error written as `NOT_CONFIRMED()`. */
const ERROR_SIGNATURE_RE = /\b[A-Z][A-Z0-9_]{3,}\(\)/;
const ARCHIVED_RE = /archived|first deployment/i;
const PENDING_RE = /\bTODO\b|pending demo run/i;

/**
 * `0.0.7314364@1793963078.419965153` and `0.0.7314364-1793963078-419965153` both become the dashed form.
 * A bare consensus timestamp (`1793964046.045736810`, which HashScan also accepts) is left as is.
 */
export function normalizeTransactionId(raw: string): string {
  const at = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(raw);
  return at ? `${at[1]}-${at[2]}-${at[3]}` : raw;
}

/** The text after the last sentence boundary of `gap` (the part that leads into the next link). */
const sentenceEnd = (gap: string) => gap.slice(gap.lastIndexOf(". ") + 1);
/** The text up to the first sentence boundary of `gap` (the part that trails the previous link). */
const sentenceStart = (gap: string) => (gap.includes(". ") ? gap.slice(0, gap.indexOf(". ")) : gap);

/** `context` is the sentence text on either side of the link, up to the neighbouring links. */
function expectationFor(kind: LinkKind, context: string): Expectation {
  if (kind !== "transaction") return { type: "success" };
  const status = STATUS_RE.exec(context)?.[1];
  if (status) return { type: "failure", status };
  if (FAILURE_WORD_RE.test(context) || ERROR_SIGNATURE_RE.test(context)) return { type: "failure" };
  return { type: "success" };
}

/** Marks every line of each `## ` section whose leading blockquote (`> ...`) says it is archived. */
function archivedSections(lines: string[]): boolean[] {
  const archived = new Array<boolean>(lines.length).fill(false);
  let start = 0;
  let sectionArchived = false;
  const close = (end: number) => {
    if (sectionArchived) for (let i = start; i < end; i++) archived[i] = true;
  };
  lines.forEach((text, i) => {
    if (/^## /.test(text)) {
      close(i);
      start = i;
      sectionArchived = false;
    } else if (/^> /.test(text) && ARCHIVED_RE.test(text)) {
      sectionArchived = true;
    }
  });
  close(lines.length);
  return archived;
}

/** Marks every line of each `<details>` block whose `<summary>` says it is archived. */
function archivedDetails(lines: string[], archived: boolean[]): void {
  let start = -1;
  let blockArchived = false;
  lines.forEach((text, i) => {
    if (/<details>/.test(text)) {
      start = i;
      blockArchived = false;
    }
    if (start >= 0 && /<summary>/.test(text) && ARCHIVED_RE.test(text)) blockArchived = true;
    if (start >= 0 && /<\/details>/.test(text)) {
      if (blockArchived) for (let j = start; j <= i; j++) archived[j] = true;
      start = -1;
    }
  });
}

/**
 * Archived regions: a `## ` section whose leading blockquote says it is archived or describes the first
 * deployment, a README `<details>` block whose summary says so, or any single line that says so (for example a
 * table column "Archived first deployment").
 */
export function parseEvidence(markdown: string, file: string): { links: EvidenceLink[]; pending: PendingMarker[] } {
  const links: EvidenceLink[] = [];
  const pending: PendingMarker[] = [];
  const lines = markdown.split("\n");
  const archivedLine = archivedSections(lines);
  archivedDetails(lines, archivedLine);

  lines.forEach((text, i) => {
    if (PENDING_RE.test(text)) pending.push({ file, line: i + 1, text: text.trim() });
    const matches = [...text.matchAll(LINK_RE)];
    matches.forEach((match, k) => {
      const before = text.slice(k === 0 ? 0 : matches[k - 1].index! + matches[k - 1][0].length, match.index);
      const after = text.slice(match.index! + match[0].length, k === matches.length - 1 ? text.length : matches[k + 1].index);
      const kind = match[1] as LinkKind;
      const raw = match[2].replace(/[.,;:]+$/, "");
      links.push({
        file,
        line: i + 1,
        url: `https://hashscan.io/testnet/${kind}/${raw}`,
        kind,
        id: kind === "transaction" ? normalizeTransactionId(raw) : raw,
        archived: archivedLine[i] || ARCHIVED_RE.test(text),
        expect: expectationFor(kind, sentenceEnd(before) + sentenceStart(after)),
      });
    });
  });
  return { links, pending };
}

export type DistinctLink = EvidenceLink & { occurrences: string[] };

/** One row per distinct entity; archived only if every occurrence is archived, a failure expectation wins. */
export function dedupeLinks(links: EvidenceLink[]): DistinctLink[] {
  const byKey = new Map<string, DistinctLink>();
  for (const link of links) {
    const key = `${link.kind}:${link.id.toLowerCase()}`;
    const where = `${link.file}:${link.line}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...link, occurrences: [where] });
      continue;
    }
    existing.occurrences.push(where);
    existing.archived = existing.archived && link.archived;
    if (existing.expect.type === "success" && link.expect.type === "failure") existing.expect = link.expect;
  }
  return [...byKey.values()];
}

/** Mirror-node REST path (relative to /api/v1) that proves the entity exists. */
export function mirrorPath(link: Pick<EvidenceLink, "kind" | "id">): string {
  switch (link.kind) {
    case "transaction":
      // An EVM hash (0x…) is only known to the mirror node as a contract result; a bare consensus timestamp is a
      // transaction lookup by timestamp; anything else is a Hedera transaction id.
      if (/^0x[0-9a-fA-F]{64}$/.test(link.id)) return `/contracts/results/${link.id}`;
      return /^\d+\.\d+$/.test(link.id) ? `/transactions?timestamp=${link.id}` : `/transactions/${link.id}`;
    case "contract":
      return `/contracts/${link.id}`;
    case "account":
      return `/accounts/${link.id}`;
    case "topic":
      return `/topics/${link.id}/messages?limit=1`;
    case "token":
      return `/tokens/${link.id}`;
    case "schedule":
      return `/schedules/${link.id}`;
  }
}
