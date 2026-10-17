export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// Records have module-specific payloads; pages may narrow these with the generic.
export interface RecordItem<T = Record<string, any>> {
  id: string;
  kind: string;
  revision: number;
  workspace_id: string;
  data: T;
  created_at: string;
  updated_at: string;
}

export interface Page<T = RecordItem> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Session {
  user: { id: string; display_name: string; email: string };
  workspace: { id: string; name: string; role: 'owner' | 'adviser' | 'worker'; farm_ids?: string[] | null; permissions?: string[] };
  csrf_token: string;
  token?: string;
}

export interface Pack {
  id: string;
  name?: string;
  title?: string;
  country: string | null;
  year?: number;
  reporting_year?: number;
  description?: string;
  requirements?: any[];
  fields?: any[];
  [key: string]: any;
}
