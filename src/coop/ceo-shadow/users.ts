/**
 * Linear user-id constants for the RYA team.
 *
 * Captured 2026-05-03 via raw GraphQL `users` query. RYA-845.
 */

export const CEO_USER_ID = '17365a90-5487-4ce8-91f6-0ddae84c750a'; // Zhiyuan Wang

export const AGENT_USER_IDS: Record<string, string> = {
  ops: '1f4d2ee9-4cb4-4243-9c91-9dcc8249fb48',
  strategist: 'b7171924-f008-49eb-a6f9-9603fdce960f',
  engineer: '0000aa44-7f3e-4d47-a1cc-4eadebdef64d',
  'linear-bot': '6ab34d4c-4687-405e-bc04-f0fa1218ab21',
  'qa-engineer': '90abd661-b78f-4d51-9f16-2da75062be8f',
  'research-lead': '614ec10f-258d-4c80-a53f-01f4e85f6ce4',
  'lead-engineer': '5b32bd92-4b4b-4414-bc1d-94109167f038',
  coo: '32d0f5ed-728b-436f-a536-40dd35337b81',
  cpo: '9f1552c1-0f37-41cc-8ed7-14ae8cbb70e0',
  cto: 'afd589ca-0cfc-4b47-8b1f-fe0e2b23f3a8',
  'ceo-office': '847a38c9-4047-4816-82ca-3e1055c7e435',
};

const ID_TO_ROLE: Record<string, string> = {
  [CEO_USER_ID]: 'ceo',
  ...Object.fromEntries(Object.entries(AGENT_USER_IDS).map(([role, id]) => [id, role])),
};

const NAME_TO_ROLE: Record<string, string> = {
  'Zhiyuan Wang': 'ceo',
  'Ops': 'ops',
  'Strategist': 'strategist',
  'Engineer': 'engineer',
  'Linear': 'linear-bot',
  'QA Engineer': 'qa-engineer',
  'Research Lead': 'research-lead',
  'Lead Engineer': 'lead-engineer',
  'COO': 'coo',
  'CPO': 'cpo',
  'CTO': 'cto',
  'CEO Office': 'ceo-office',
};

export function roleFromId(id: string | null | undefined): string {
  if (!id) return 'unknown';
  return ID_TO_ROLE[id] ?? 'unknown';
}

export function roleFromName(name: string | null | undefined): string {
  if (!name) return 'unknown';
  return NAME_TO_ROLE[name] ?? 'unknown';
}

export function isCeoActor(actor: { id?: string; name?: string } | null | undefined): boolean {
  if (!actor) return false;
  if (actor.id === CEO_USER_ID) return true;
  if (actor.name === 'Zhiyuan Wang') return true;
  return false;
}
