import { api, errorMessage } from './api';

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; consequentialHint: boolean; untrustedContentHint: boolean };
};
type ModelContext = {
  registerTool(tool: Tool & { execute: (input: unknown, options?: { signal?: AbortSignal }) => Promise<string> }, options: { signal: AbortSignal }): Promise<void> | void;
};
type Proposal = {
  id: string; revision: number; checksum: string; status: string; action: string;
  farm_id: string; farm_name: string; recipient: string | null; expires_at: string; payload: unknown; notice: string;
};
type Credential = { id: string; revision: number; data: { name: string; farm_ids: string[]; permissions: string[]; expires_at: string; revoked_at: string | null } };
type FarmChoice = { id: string; data: { name?: string } };
const names = new Set([
  'list_tasks', 'find_records', 'check_request', 'preview_request', 'preview_journal', 'propose_capture', 'export_approved',
  'farm_overview', 'read_document', 'missing_answers', 'animal_events', 'list_fields', 'field_change_diff',
  'check_capture', 'check_compliance', 'propose_checklist', 'report_dependencies', 'list_deadlines',
  'regulatory_changes', 'adviser_help', 'propose_request', 'propose_field_change',
  'list_cases', 'read_case', 'check_case', 'propose_case_draft',
  'read_lpis_guide', 'check_parcels',
]);
const identifier = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Current document.modelContext only; no polyfill, global token or support claim.
 * Mount inside the authenticated shell and remount when identity/workspace changes.
 * Browser tools and native MCP share the same bounded server dispatcher.
 */
export function mountWebMCP(): () => void {
  const lifecycle = new AbortController();
  const registrations = new AbortController();
  const context = (document as Document & { modelContext?: ModelContext }).modelContext;
  let review: HTMLDialogElement | null = null;
  let reviewGeneration = 0;
  let secretInput: HTMLInputElement | null = null;
  let accessControl: HTMLButtonElement | null = null;

  const clearReview = () => { reviewGeneration++; if (secretInput) secretInput.value = ''; secretInput = null; review?.close(); review?.remove(); review = null; };

  const showAssistantAccess = async (event: MouseEvent) => {
    if (!event.isTrusted || lifecycle.signal.aborted) return;
    clearReview();
    const generation = reviewGeneration;
    const dialog = document.createElement('dialog');
    review = dialog; dialog.className = 'panel';
    dialog.setAttribute('aria-label', 'Connect an AI assistant');
    dialog.style.maxWidth = 'min(44rem, 92vw)'; dialog.style.maxHeight = '85vh';
    const title = document.createElement('h2'); title.textContent = 'Connect an AI assistant';
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    status.textContent = 'Choose exactly which farms and operations this client may access. Keys cannot approve evidence, issue reports or file paperwork.';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close';
    close.addEventListener('click', clearReview); dialog.addEventListener('cancel', clearReview);
    dialog.append(title, status, close); document.body.append(dialog); dialog.showModal();
    try {
      const [credentials, farms] = await Promise.all([
        api.get<{ items: Credential[] }>('/assistant/credentials'),
        api.get<{ items: FarmChoice[]; total: number }>('/farms?limit=100'),
      ]);
      if (lifecycle.signal.aborted || generation !== reviewGeneration) return;
      const form = document.createElement('form'); form.className = 'stack';
      const field = (label: string, input: HTMLElement) => {
        const wrapper = document.createElement('label'); wrapper.className = 'field';
        const text = document.createElement('span'); text.textContent = label;
        wrapper.append(text, input); return wrapper;
      };
      const clientName = document.createElement('input'); clientName.required = true; clientName.maxLength = 120;
      clientName.autocomplete = 'off';
      form.append(field('Assistant client name', clientName));
      const farmSet = document.createElement('fieldset');
      const legend = document.createElement('legend'); legend.textContent = 'Allow access to selected farms only'; farmSet.append(legend);
      const choices: { id: string; checkbox: HTMLInputElement }[] = [];
      for (const farm of farms.items) {
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
        choices.push({ id: farm.id, checkbox }); farmSet.append(field(farm.data.name ?? farm.id, checkbox));
      }
      if (farms.total > farms.items.length) {
        const note = document.createElement('p'); note.textContent = 'Showing the first 100 farms. Use separate keys for selected farms; no all-farms shortcut is granted.'; farmSet.append(note);
      }
      form.append(farmSet);
      const permission = document.createElement('select');
      for (const [value, label] of [['read', 'Read records only'], ['propose', 'Read and stage proposals for my review']]) {
        const option = document.createElement('option'); option.value = value; option.textContent = label; permission.append(option);
      }
      const expiry = document.createElement('input'); expiry.type = 'number'; expiry.required = true; expiry.min = '1'; expiry.max = '30'; expiry.value = '7';
      form.append(field('Permitted operations', permission), field('Expires after days (1–30)', expiry));
      const create = document.createElement('button'); create.type = 'submit'; create.textContent = 'Create restricted key';
      create.disabled = choices.length === 0; form.append(create);
      const endpoint = document.createElement('p');
      endpoint.textContent = `MCP endpoint: ${window.location.origin}/api/v1/assistant/mcp. Configure the key as a Bearer credential in a trusted MCP client, not in a prompt. Never use your ordinary account session.`;
      let busy = false;
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (!event.isTrusted || busy || lifecycle.signal.aborted) return;
        const farmIds = choices.filter(choice => choice.checkbox.checked).map(choice => choice.id);
        if (!farmIds.length) { status.textContent = 'Select at least one farm.'; return; }
        busy = true; create.disabled = true;
        void api.post<{ token: string; credential: Credential; notice: string }>('/assistant/credentials', {
          name: clientName.value.trim(), farm_ids: farmIds,
          permissions: permission.value === 'propose' ? ['read', 'propose'] : ['read'], expires_in_days: Number(expiry.value),
        }).then(result => {
          if (lifecycle.signal.aborted || generation !== reviewGeneration) return;
          const key = document.createElement('input'); key.type = 'password'; key.readOnly = true;
          key.autocomplete = 'off'; key.spellcheck = false; key.value = result.token;
          result.token = '';
          secretInput = key;
          const reveal = document.createElement('button'); reveal.type = 'button'; reveal.textContent = 'Show key once';
          reveal.addEventListener('click', event => { if (event.isTrusted) { key.type = key.type === 'password' ? 'text' : 'password'; reveal.textContent = key.type === 'password' ? 'Show key once' : 'Hide key'; } });
          status.textContent = result.notice;
          form.replaceChildren(field('New key — available only until this dialog closes', key), reveal);
          const revoked = document.createElement('button'); revoked.type = 'button'; revoked.textContent = 'Revoke this new key';
          revoked.addEventListener('click', event => {
            if (!event.isTrusted) return;
            revoked.disabled = true;
            void api.post(`/assistant/credentials/${result.credential.id}/revoke`, { expected_revision: result.credential.revision })
              .then(() => { key.value = ''; status.textContent = 'The new key was revoked.'; reveal.disabled = true; })
              .catch(failure => { status.textContent = errorMessage(failure); revoked.disabled = false; });
          });
          form.append(revoked);
        }).catch(failure => {
          if (!lifecycle.signal.aborted && generation === reviewGeneration) { status.textContent = errorMessage(failure); create.disabled = false; }
        }).finally(() => { busy = false; });
      });
      dialog.insertBefore(endpoint, close); dialog.insertBefore(form, close);
      const heading = document.createElement('h3'); heading.textContent = 'Existing assistant access'; dialog.insertBefore(heading, close);
      for (const credential of credentials.items) {
        const row = document.createElement('p');
        row.textContent = `${credential.data.name} · ${credential.data.farm_ids.length} farms · ${credential.data.permissions.join(', ')} · expires ${credential.data.expires_at} `;
        const revoke = document.createElement('button'); revoke.type = 'button'; revoke.textContent = credential.data.revoked_at ? 'Revoked' : 'Revoke';
        revoke.disabled = Boolean(credential.data.revoked_at);
        revoke.addEventListener('click', event => {
          if (!event.isTrusted || revoke.disabled) return;
          revoke.disabled = true;
          void api.post(`/assistant/credentials/${credential.id}/revoke`, { expected_revision: credential.revision })
            .then(() => { revoke.textContent = 'Revoked'; })
            .catch(failure => { status.textContent = errorMessage(failure); revoke.disabled = false; });
        });
        row.append(revoke); dialog.insertBefore(row, close);
      }
    } catch (failure) {
      if (!lifecycle.signal.aborted && generation === reviewGeneration) status.textContent = errorMessage(failure);
    }
  };

  const showReview = async (approvalId: string) => {
    if (!identifier.test(approvalId) || lifecycle.signal.aborted) return;
    clearReview();
    const generation = reviewGeneration;
    const dialog = document.createElement('dialog');
    review = dialog;
    dialog.className = 'panel';
    dialog.setAttribute('aria-label', 'Review assistant proposal');
    dialog.style.maxWidth = 'min(48rem, 92vw)';
    dialog.style.maxHeight = '85vh';
    const title = document.createElement('h2');
    title.textContent = 'Review assistant proposal';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = 'Loading the exact saved proposal…';
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = 'Close';
    close.addEventListener('click', clearReview);
    dialog.append(title, status, close);
    dialog.addEventListener('cancel', clearReview);
    document.body.append(dialog);
    dialog.showModal();
    try {
      const proposal = await api.get<Proposal>(`/assistant/approvals/${approvalId}`);
      if (lifecycle.signal.aborted || generation !== reviewGeneration) return;
      const details = document.createElement('p');
      details.textContent = `Farm: ${proposal.farm_name} (${proposal.farm_id}). Recipient: ${proposal.recipient ?? 'Not supplied'}. Expires: ${proposal.expires_at}.`;
      const notice = document.createElement('p');
      notice.textContent = proposal.notice;
      const payload = document.createElement('pre');
      payload.style.whiteSpace = 'pre-wrap'; payload.style.overflowWrap = 'anywhere';
      payload.textContent = JSON.stringify(proposal.payload, null, 2);
      const binding = document.createElement('p');
      binding.textContent = `Proposal revision ${proposal.revision} · SHA-256 ${proposal.checksum}`;
      const saleCapture = proposal.action === 'capture_proposed_record' && isObject(proposal.payload) && proposal.payload.kind === 'sales';
      const portugueseCapture = proposal.action === 'capture_proposed_record' && isObject(proposal.payload)
        && proposal.payload.kind === 'facts' && isObject(proposal.payload.data) && proposal.payload.data.key === 'pt.ppp.surface_journal';
      const actionDescriptions: Record<string, string> = {
        create_report_draft: 'This creates only the draft shown below. It does not approve, issue, send or file a report.',
        create_request_draft: 'Review the letter source, recipient, exact questions, reporting period and nullable deadline. This creates only a draft request; nothing is answered, confirmed, sent or filed.',
        create_checklist_drafts: 'Review the selected source-backed obligations and evidence below. This creates incomplete checklists and open tasks only; it does not establish applicability, legal compliance or sustainability certification.',
        create_field_change_draft: 'Review the field comparison, supplied reference and overlap warnings below. This saves a field-change proposal only; it does not change the saved field outline, approve overlaps or alter official LPIS.',
        create_case_draft: 'Review this field, correction or inspection case, its year, original reference and explicitly pinned records. This saves a private draft case only. It does not review the case, change fields, send anything, record a receipt or mark an authority outcome.',
      };
      status.textContent = actionDescriptions[proposal.action] ?? (portugueseCapture
        ? 'Review these literal Portuguese journal values. Saving keeps a proposed source fact only, with every actual date unconfirmed. Open the journal afterward to check dates and separately confirm the source before selecting report rows. Nothing is issued or sent.'
        : saleCapture
        ? 'Check the sale’s buyer, actual date, amount and currency below. This saves only a proposed sale; evidence remains unconfirmed and nothing is sent or filed.'
        : 'Check the values, sources and warnings below. This saves only a proposed record; evidence remains unconfirmed and tasks remain open.');
      const approve = document.createElement('button');
      approve.type = 'button';
      const actionLabels: Record<string, string> = {
        create_report_draft: 'Create this draft report', create_request_draft: 'Create this draft request',
        create_checklist_drafts: 'Create these incomplete checklists', create_field_change_draft: 'Save this field-change proposal',
        create_case_draft: 'Save this draft case',
      };
      approve.textContent = actionLabels[proposal.action] ?? (portugueseCapture ? 'Save this Portuguese journal proposal' : 'Save this proposed record');
      const reject = document.createElement('button');
      reject.type = 'button'; reject.textContent = 'Reject proposal';
      const actionable = proposal.status === 'pending' && Date.parse(proposal.expires_at) > Date.now();
      approve.disabled = reject.disabled = !actionable;
      if (!actionable) status.textContent = 'This proposal is used, rejected or expired. Ask for a new proposal.';
      let busy = false;
      let decided = false;
      const captureCheck = proposal.action === 'capture_proposed_record' && isObject(proposal.payload) && isObject(proposal.payload.capture_check) ? proposal.payload.capture_check : null;
      const warningCodes = captureCheck && Array.isArray(captureCheck.requires_acknowledgement)
        ? [...new Set(captureCheck.requires_acknowledgement.filter((code): code is string => typeof code === 'string'))].slice(0, 100) : [];
      const warningChoices: { code: string; checkbox: HTMLInputElement }[] = [];
      const acknowledgedCodes = new Set<string>();
      const warnings = document.createElement('fieldset');
      if (warningCodes.length) {
        const legend = document.createElement('legend'); legend.textContent = 'Check and acknowledge each record warning'; warnings.append(legend);
        for (const code of warningCodes) {
          const issue = captureCheck && Array.isArray(captureCheck.issues) ? captureCheck.issues.find(value => isObject(value) && value.code === code) : null;
          const label = document.createElement('label'); label.className = 'field';
          const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.disabled = !actionable;
          const message = document.createElement('span'); message.textContent = isObject(issue) && typeof issue.message === 'string' ? issue.message : code;
          warningChoices.push({ code, checkbox }); label.append(checkbox, message); warnings.append(label);
          checkbox.addEventListener('change', event => {
            if (!event.isTrusted || decided) return;
            if (checkbox.checked) acknowledgedCodes.add(code); else acknowledgedCodes.delete(code);
            approve.disabled = !actionable || busy || warningCodes.some(code => !acknowledgedCodes.has(code));
          });
        }
        approve.disabled = true;
      }
      const decide = async (event: MouseEvent, action: 'approve' | 'reject') => {
        // A model result or synthetic DOM click is not a human approval action.
        if (!event.isTrusted || busy || decided || !actionable || lifecycle.signal.aborted || !dialog.open || (action === 'approve' && warningCodes.some(code => !acknowledgedCodes.has(code)))) return;
        busy = true; approve.disabled = reject.disabled = true;
        try {
          const result = await api.post<{ status: string; result: { id?: string; kind: string; view_url?: string } | null }>(`/assistant/approvals/${approvalId}/${action}`, {
            expected_revision: proposal.revision, checksum: proposal.checksum,
            ...(captureCheck && action === 'approve' ? {
              acknowledged_codes: [...acknowledgedCodes],
              check_token: typeof captureCheck?.check_token === 'string' ? captureCheck.check_token : null,
            } : {}),
          });
          if (lifecycle.signal.aborted || generation !== reviewGeneration) return;
          decided = true;
          for (const choice of warningChoices) choice.checkbox.disabled = true;
          status.textContent = result.status === 'consumed' ? 'Saved as a draft or proposal after your review. No evidence was confirmed and nothing was issued, sent or filed.' : 'Proposal rejected. No farm record was created.';
          if (result.result) {
            const link = document.createElement('a');
            link.textContent = portugueseCapture ? 'Open the Portuguese journal' : result.result.kind === 'reports' ? 'Open draft report' : result.result.kind === 'requests' ? 'Open draft request' : result.result.kind === 'admin_cases' ? 'Open draft case' : 'Open farm records';
            link.href = result.result.view_url?.startsWith('/app/') ? result.result.view_url
              : portugueseCapture ? `/app/record-work?farm_id=${proposal.farm_id}#portuguese-journal`
              : result.result.kind === 'reports' && result.result.id ? `/app/reports/${result.result.id}`
              : result.result.kind === 'requests' && result.result.id ? `/app/paperwork/${result.result.id}`
              : result.result.kind === 'admin_cases' && result.result.id ? `/app/cases/${result.result.id}` : `/app/fields/${proposal.farm_id}`;
            dialog.append(link);
          }
          window.dispatchEvent(new CustomEvent('assistant-proposal-reviewed', { detail: { approvalId, status: result.status } }));
        } catch (failure) {
          if (!lifecycle.signal.aborted && generation === reviewGeneration) status.textContent = `${errorMessage(failure)} Close this review and request a fresh proposal.`;
        } finally { busy = false; }
      };
      approve.addEventListener('click', event => { void decide(event, 'approve'); });
      reject.addEventListener('click', event => { void decide(event, 'reject'); });
      dialog.insertBefore(details, close); dialog.insertBefore(notice, close);
      dialog.insertBefore(payload, close); dialog.insertBefore(binding, close);
      if (warningCodes.length) dialog.insertBefore(warnings, close);
      dialog.insertBefore(approve, close); dialog.insertBefore(reject, close);
    } catch (failure) {
      if (!lifecycle.signal.aborted && generation === reviewGeneration) status.textContent = errorMessage(failure);
    }
  };

  const reviewFromLocation = () => {
    const id = new URL(window.location.href).searchParams.get('assistant_review');
    if (id) void showReview(id);
  };
  reviewFromLocation();
  window.addEventListener('popstate', reviewFromLocation);
  // The owner opts in through a visible control. No credential screen opens
  // automatically and no key is ever passed to document.modelContext.
  void api.get('/assistant/credentials').then(() => {
    if (lifecycle.signal.aborted) return;
    accessControl = document.createElement('button'); accessControl.type = 'button';
    accessControl.className = 'text-button'; accessControl.textContent = 'Connect an AI assistant';
    accessControl.addEventListener('click', event => { void showAssistantAccess(event); });
    document.querySelector('.workspace-footer')?.append(accessControl);
  }).catch(() => { /* Nonowners have no credential-management control. */ });

  if (window.isSecureContext && context && typeof context.registerTool === 'function') {
    void api.get<{ tools: Tool[] }>('/assistant/tools').then(async catalog => {
      if (lifecycle.signal.aborted) return;
      for (const tool of catalog.tools) {
        if (!names.has(tool.name)) continue;
        await context.registerTool({ ...tool, execute: async (input, options) => {
          if (lifecycle.signal.aborted || options?.signal?.aborted) throw new Error('The signed-in workspace changed or this action was cancelled.');
          if (!isObject(input) || JSON.stringify(input).length > 32000) throw new Error('Use bounded structured tool arguments.');
          const result = await api.post<unknown>(`/assistant/execute/${tool.name}`, { arguments: input });
          if (lifecycle.signal.aborted || options?.signal?.aborted) throw new Error('Action cancelled. Open the application to inspect any pending proposal; it was not approved.');
          if (isObject(result) && result.status === 'requires_human_review' && typeof result.approval_id === 'string') void showReview(result.approval_id);
          return JSON.stringify(result);
        } }, { signal: registrations.signal });
        if (lifecycle.signal.aborted) return;
      }
    }).catch(() => {
      // Unsupported/failed registration leaves normal app controls available.
      registrations.abort();
    });
  }

  return () => { lifecycle.abort(); registrations.abort(); clearReview(); accessControl?.remove(); window.removeEventListener('popstate', reviewFromLocation); };
}
