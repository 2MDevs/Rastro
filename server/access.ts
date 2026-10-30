import { pool, Queryable } from './db';
import { HttpError, forbidden } from './http';

/**
 * Perfis e permissões do RASTRO. Tudo é conferido no servidor, em cada rota.
 *
 * Painel Matriz (enxergam todas as lojas): Desenvolvedor, Administrador, Diretor, Coordenador.
 * Loja (enxergam só as lojas vinculadas a eles): Gerente de loja, Divulgador.
 */

export const ROLES = ['DEVELOPER', 'ADMIN', 'DIRECTOR', 'FRANCHISE_MANAGER', 'COORDINATOR', 'STORE_MANAGER', 'PROMOTER'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  DEVELOPER: 'Desenvolvedor',
  ADMIN: 'Administrador',
  DIRECTOR: 'Diretor',
  FRANCHISE_MANAGER: 'Gestor da franquia',
  COORDINATOR: 'Coordenador',
  STORE_MANAGER: 'Gerente de loja',
  PROMOTER: 'Divulgador',
};

export const MATRIX_ROLES: Role[] = ['DEVELOPER', 'ADMIN', 'DIRECTOR', 'FRANCHISE_MANAGER', 'COORDINATOR'];

export type Capability =
  | 'matrix.view'          // Painel Matriz, todas as lojas
  | 'stores.manage'        // criar/alterar lojas
  | 'stores.locate'        // registrar a localização da loja (GPS dentro da loja)
  | 'territory.manage'     // territórios, pontos de interesse
  | 'campaigns.manage'     // campanhas, ruas planejadas, responsáveis
  | 'tracking.view'        // ver percursos de outras pessoas
  | 'reports.view'
  | 'users.manage'
  | 'devices.manage'       // dispositivos de todos
  | 'audit.view'
  | 'system.view'          // tela Sistema (recursos, servidor, artefatos)
  | 'apikeys.manage'
  | 'integration.manage'   // tela Integração (só desenvolvedor)
  | 'infra.destructive';   // ações destrutivas de infraestrutura (só desenvolvedor)

const CAPS: Record<Role, Capability[]> = {
  DEVELOPER: [
    'matrix.view', 'stores.manage', 'stores.locate', 'territory.manage', 'campaigns.manage', 'tracking.view', 'reports.view',
    'users.manage', 'devices.manage', 'audit.view', 'system.view', 'apikeys.manage', 'integration.manage',
    'infra.destructive',
  ],
  ADMIN: [
    'matrix.view', 'stores.manage', 'stores.locate', 'territory.manage', 'campaigns.manage', 'tracking.view', 'reports.view',
    'users.manage', 'devices.manage', 'audit.view', 'system.view', 'apikeys.manage',
  ],
  DIRECTOR: [
    'matrix.view', 'stores.manage', 'stores.locate', 'territory.manage', 'campaigns.manage', 'tracking.view', 'reports.view',
    'users.manage', 'devices.manage', 'audit.view', 'system.view', 'apikeys.manage',
  ],
  // Gestor da franquia: todas as lojas e todos os percursos; cadastra lojas e as pessoas das lojas
  FRANCHISE_MANAGER: [
    'matrix.view', 'stores.manage', 'stores.locate', 'territory.manage', 'campaigns.manage', 'tracking.view', 'reports.view',
    'users.manage',
  ],
  COORDINATOR: ['matrix.view', 'territory.manage', 'campaigns.manage', 'tracking.view', 'reports.view'],
  STORE_MANAGER: ['stores.locate', 'territory.manage', 'campaigns.manage', 'tracking.view', 'reports.view'],
  PROMOTER: [],
};

export function can(role: Role, cap: Capability): boolean {
  return CAPS[role]?.includes(cap) ?? false;
}

export function capabilitiesOf(role: Role): Capability[] {
  return [...(CAPS[role] ?? [])];
}

/** Quais perfis cada perfil pode criar/editar (ninguém cria alguém acima de si) */
export function assignableRoles(role: Role): Role[] {
  if (role === 'DEVELOPER') return [...ROLES];
  if (role === 'ADMIN' || role === 'DIRECTOR') return ['ADMIN', 'DIRECTOR', 'FRANCHISE_MANAGER', 'COORDINATOR', 'STORE_MANAGER', 'PROMOTER'];
  if (role === 'FRANCHISE_MANAGER') return ['STORE_MANAGER', 'PROMOTER'];
  return [];
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: string;
  mustChangePassword: boolean;
  hasPin: boolean;
  /** 'ALL' para os perfis da Matriz; lista de lojas para gerente e divulgador */
  storeScope: 'ALL' | string[];
  /** Nome usado na auditoria ("Nome (API: chave)" quando a ação veio de uma chave) */
  auditName: string;
  apiKey?: { id: string; name: string; scopes: string[] };
  sessionId?: string;
}

export function isDeveloperEmail(email: string): boolean {
  const list = (process.env.DEVELOPER_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}

/** Monta o usuário da sessão a partir da linha do banco */
export async function loadSessionUser(row: any, db: Queryable = pool): Promise<SessionUser> {
  // E-mails em DEVELOPER_EMAILS sempre têm o perfil Desenvolvedor
  const role: Role = isDeveloperEmail(row.email) ? 'DEVELOPER' : row.role;
  let storeScope: 'ALL' | string[] = 'ALL';
  if (!MATRIX_ROLES.includes(role)) {
    const { rows } = await db.query('SELECT store_id FROM user_store_access WHERE user_id = $1', [row.id]);
    storeScope = rows.map((r) => r.store_id);
  }
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role,
    status: row.status,
    mustChangePassword: Boolean(row.must_change_password),
    hasPin: Boolean(row.pin_hash),
    storeScope,
    auditName: row.name,
  };
}

export function requireCap(user: SessionUser, cap: Capability) {
  if (!can(user.role, cap)) throw forbidden();
}

export function hasStoreAccess(user: SessionUser, storeId: string): boolean {
  return user.storeScope === 'ALL' || user.storeScope.includes(storeId);
}

/** Lança 404 (e não 403) para não revelar que a loja de outra unidade existe */
export function assertStoreAccess(user: SessionUser, storeId: string | null | undefined) {
  if (!storeId || !hasStoreAccess(user, storeId)) throw new HttpError(404, 'Loja não encontrada.');
}

/**
 * Filtro SQL por escopo de lojas. Devolve o trecho e acrescenta o parâmetro na lista.
 * Ex.: const where = scopeSql(user, 'c.store_id', params)  →  "c.store_id = ANY($3)" ou "TRUE"
 */
export function scopeSql(user: SessionUser, column: string, params: unknown[]): string {
  if (user.storeScope === 'ALL') return 'TRUE';
  params.push(user.storeScope);
  return `${column} = ANY($${params.length}::text[])`;
}

/** Nome do escopo para a auditoria */
export async function storeLabel(storeId: string | null | undefined, db: Queryable = pool): Promise<string> {
  if (!storeId) return 'Geral';
  const { rows } = await db.query('SELECT code, name FROM stores WHERE id = $1', [storeId]);
  return rows[0] ? `${rows[0].name} (${rows[0].code})` : 'Loja removida';
}
