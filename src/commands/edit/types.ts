// src/commands/edit/types.ts

export type EditTarget = 'qimochi' | 'yukionime';

export type FieldType = 'text' | 'body' | 'url' | 'choice';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  choices?: string[];
  hint?: string;
}

export type EditState = 'awaiting_slug' | 'awaiting_value' | 'menu';

export interface PendingEditRow {
  session_id: string;
  user_id: number;
  target: EditTarget;
  slug: string;
  state: EditState;
  active_field: string | null;
  base_content: string;
  edits_json: string;
  created_at: number;
  expires_at: number;
}