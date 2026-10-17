export const pppReadbackFields = [
  ['treatment_type', 'Treatment type'], ['product_authorisation', 'Product authorisation number'],
  ['operator', 'Person who applied it'], ['contractor', 'Contractor'], ['dose', 'Dose used'],
  ['dose_unit', 'Dose unit'], ['treated_size', 'Actual area, facility size or seed quantity treated'],
  ['treated_unit', 'Treated size unit'], ['treated_location', 'Actual treated location'],
  ['crop', 'Crop or use'], ['start_time', 'Application start time'], ['eppo_code', 'EPPO crop or use code'],
  ['bbch_stage', 'BBCH growth stage'], ['batch_number', 'Batch number'],
  ['label_time_required', 'Label requires a start time'], ['label_growth_stage_required', 'Label requires a growth stage'],
] as const;

const labels: Record<string, string> = {
  title: 'Entry', date: 'Date', parcel: 'Field or place', product: 'Product or group', quantity: 'Quantity',
  unit: 'Unit', amount: 'Amount', currency: 'Currency', buyer: 'Buyer', invoice_number: 'Invoice number',
  tax_amount: 'Printed tax amount', tax_rate: 'Printed tax rate', credit: 'Credit note or refund', note: 'Note',
  ...Object.fromEntries(pppReadbackFields),
};

export const readbackLabel = (key: string) => labels[key] || key.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());

export function readbackValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not supplied';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.map(readbackValue).join(', ') : 'Not supplied';
  if (typeof value === 'object') return Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== '')
    .map(([key, item]) => `${readbackLabel(key)}: ${readbackValue(item)}`).join('; ') || 'Not supplied';
  return String(value);
}

export function PppReadback({ data }: { data: Record<string, unknown> }) {
  if (data.type !== 'pesticide_application') return null;
  return <details open><summary>Crop protection application details</summary>
    <p className="muted">Add missing details before filing. Check the product label and what was actually applied.</p>
    <dl className="farm-entry-summary">{pppReadbackFields.map(([key, label]) => {
      const value = data[key];
      const answer = key === 'label_time_required' || key === 'label_growth_stage_required'
        ? value === true ? 'Yes' : value === false ? 'No' : 'Not known / label not checked'
        : key === 'treatment_type'
          ? typeof value === 'string' ? ({ surface: 'An area or crop surface', closed_space: 'An enclosed facility', seed: 'Seed treatment' } as Record<string, string>)[value] || 'Not supplied' : 'Not supplied'
          : readbackValue(value);
      return <div key={key}><dt>{label}</dt><dd>{answer}</dd></div>;
    })}</dl>
  </details>;
}
