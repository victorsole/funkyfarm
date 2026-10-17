import type { RecordItem } from '../types';

export type CaseJob = 'fields' | 'correction' | 'inspection';
export type CaseStatus = 'draft' | 'ready_to_send' | 'sent' | 'receipt_saved' | 'needs_changes' | 'accepted_recorded' | 'cancelled';
export type ReferenceKind = 'documents' | 'requests' | 'reports' | 'field_change_proposals' | 'facts' | 'operations' | 'checklists' | 'tasks';
export type ReferenceRole = 'original' | 'notice' | 'change' | 'response' | 'evidence';
export interface CaseReference { kind: ReferenceKind; id: string; revision: number; role: ReferenceRole }
export interface ReferenceView extends CaseReference { title?: string; current_revision?: number | null; current: boolean; href?: string }
export interface CaseItem { id: string; kind: 'requested_record' | 'finding' | 'action'; title: string; description?: string | null; due_date?: string | null; status: 'open' | 'in_progress' | 'resolved' | 'cancelled'; document_pins?: { id: string; revision: number }[]; review?: { actor_id: string; at: string; note: string } }
export interface CaseData {
  farm_id: string; title: string; job_type: CaseJob; reporting_year: number; status: CaseStatus;
  authority?: string | null; scheme?: string | null; deadline?: string | null; original_reference?: string | null;
  original_submitted_at?: string | null; reason?: string | null; references: CaseReference[]; items: CaseItem[];
  review?: { fingerprint?: string; at?: string; actor_id?: string } | null; external_status_notice?: string;
}
export type CaseSummary = Omit<CaseData, 'references' | 'items' | 'review'> & { counts?: { references: number; items: number; open_items: number } };
export interface CaseChecks {
  case_id: string; case_revision: number; fingerprint: string; can_review: boolean;
  issues: { code: string; severity: string; message: string; href?: string }[];
  references: ReferenceView[]; next_action: string; notice: string;
}
export type CaseAction = 'sent' | 'receipt' | 'needs_changes' | 'accepted' | 'reopen' | 'cancelled';
export interface CaseEventData {
  case_id: string; farm_id: string;
  action: CaseAction | 'created' | 'updated' | 'reviewed' | 'item_added' | 'item_reviewed'; date?: string; note?: string; reference?: string | null; document_id?: string | null;
  document_revision?: number | null; actor_id?: string; recorded_at?: string; case_revision?: number; external_status_notice?: string;
  sealed_bundle?: { case_revision: number; content: Partial<CaseData>; review?: CaseData['review']; handoff: CaseHandoff };
  changes?: Partial<CaseData>; item?: CaseItem; review?: CaseData['review'];
}
export interface CaseHandoff {
  case_id: string; notice: string; official_url: string | null; fields: { label: string; value: unknown }[];
  downloads: CaseDownload[]; reference_fingerprint: string;
  origin?: 'current_review' | 'sealed_sent_bundle';
}
export interface CaseDownload { label: string; href: string }
export const CASE_PACKET_MAX_BYTES = 128 * 1024 * 1024;
export interface CaseEventResult { case: RecordItem<CaseData>; event: RecordItem<CaseEventData> }

export const caseJobs: { value: CaseJob; title: string; description: string }[] = [
  { value: 'fields', title: 'Check my fields', description: 'Compare a saved field change with your records and prepare what you need to take to the official route.' },
  { value: 'correction', title: 'Correct a submitted mistake', description: 'Keep the original reference, explain the mistake and select the corrected records.' },
  { value: 'inspection', title: 'Prepare for inspection', description: 'Keep the notice and the requested records together, then work through any findings.' },
];
export const referenceKinds: { value: ReferenceKind; label: string }[] = [
  { value: 'documents', label: 'Documents' }, { value: 'requests', label: 'Letters and requests' },
  { value: 'reports', label: 'Prepared reports' }, { value: 'field_change_proposals', label: 'Saved field changes' },
  { value: 'facts', label: 'Saved farm answers' }, { value: 'operations', label: 'Farm work records' },
  { value: 'checklists', label: 'Checklists' }, { value: 'tasks', label: 'Tasks' },
];
export const referenceRoles: { value: ReferenceRole; label: string }[] = [
  { value: 'original', label: 'Original submission or record' }, { value: 'notice', label: 'Letter or inspection notice' },
  { value: 'change', label: 'The change to make' }, { value: 'response', label: 'The prepared answer' },
  { value: 'evidence', label: 'Supporting evidence' },
];
export const caseStatusLabel: Record<CaseStatus, string> = {
  draft: 'Still preparing', ready_to_send: 'Reviewed, not sent', sent: 'Sending recorded by a person',
  receipt_saved: 'Receipt recorded by a person', needs_changes: 'Changes requested',
  accepted_recorded: 'Acceptance recorded by a person', cancelled: 'Set aside',
};
export const actionLabel: Record<CaseAction, string> = {
  sent: 'Record that I sent it', receipt: 'Record an actual receipt', needs_changes: 'Record requested changes',
  accepted: 'Record an actual acceptance', reopen: 'Reopen preparation', cancelled: 'Set this case aside',
};
export function referenceDetailPath(reference: Pick<CaseReference, 'kind' | 'id'>) {
  return reference.kind === 'field_change_proposals' ? `/field-proposals/${reference.id}` : `/${reference.kind}/${reference.id}${reference.kind === 'reports' ? '?view=review' : ''}`;
}
export function referenceHref(reference: Pick<CaseReference, 'kind' | 'id'> & Partial<Pick<CaseReference, 'revision'>>, farmId: string) {
  if (reference.kind === 'field_change_proposals') return `/app/fields/${farmId}?${new URLSearchParams({ proposal_id: reference.id, ...(reference.revision ? { expected_revision: String(reference.revision) } : {}) })}#boundaries-${farmId}`;
  if (reference.kind === 'facts') return `/app/fields/${farmId}#facts`;
  if (reference.kind === 'operations') return `/app/record-work?farm_id=${farmId}&review=1`;
  if (reference.kind === 'checklists' || reference.kind === 'tasks') return `/app/checks?farm_id=${farmId}`;
  return `/app/${reference.kind === 'requests' ? 'paperwork' : reference.kind}/${reference.id}`;
}
