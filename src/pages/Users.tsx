import { FormEvent, useState } from 'react';
import { Plus, UserPlus, Pencil, Lock, Unlock, Send, Smartphone, Users as UsersIcon } from 'lucide-react';
import { shareApp } from '../lib/nativeApp';
import { ApiError, get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/useLoad';
import { relative } from '../lib/format';
import { useStores } from '../components/filters';
import { useToast } from '../components/toast';
import { Badge, Button, Card, Checkbox, Drawer, EmptyState, ErrorBox, Field, Input, Notice, PageHeader, Select, Spinner, Table, Td, useConfirm } from '../components/ui';

const MATRIX = ['DEVELOPER', 'ADMIN', 'DIRECTOR', 'FRANCHISE_MANAGER', 'COORDINATOR'];

export default function Users() {
  const { user: me } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useLoad((s) => get('/api/users', s), []);
  const [editing, setEditing] = useState<any | 'new' | null>(null);

  async function block(u: any, blocked: boolean) {
    if (!(await confirm.ask(blocked ? 'Bloquear acesso' : 'Liberar acesso', blocked ? <>Bloquear <strong>{u.name}</strong>? Todas as sessões dessa pessoa serão encerradas na hora.</> : <>Liberar o acesso de <strong>{u.name}</strong>?</>, blocked ? 'Bloquear' : 'Liberar', blocked))) return;
    try { await post(`/api/users/${u.id}/block`, { blocked }); toast('ok', blocked ? 'Acesso bloqueado.' : 'Acesso liberado.'); list.reload(true); }
    catch (err) { toast('error', err instanceof ApiError ? err.message : 'Não foi possível alterar.'); }
  }
  async function sendAccess(u: any) {
    try { await post(`/api/users/${u.id}/send-access`); toast('ok', `Link enviado para ${u.email}.`); }
    catch (err) { toast('error', err instanceof ApiError ? err.message : 'Não foi possível enviar.'); }
  }

  return (
    <div>
      {confirm.element}
      <PageHeader title="Usuários" subtitle="Pessoas com acesso, perfis e lojas vinculadas"
        actions={<Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setEditing('new')}>Novo usuário</Button>} />
      {list.error && <ErrorBox onRetry={() => list.reload()}>{list.error}</ErrorBox>}
      <Card padded={false}>
        {!list.data ? <Spinner /> : list.data.users.length ? (
          <Table head={['Pessoa', 'Perfil', 'Lojas', 'Situação', 'Último acesso', '']}>
            {list.data.users.map((u: any) => (
              <tr key={u.id} className="hover:bg-panel-2">
                <Td><div className="font-medium text-ink">{u.name}{u.id === me?.id && <span className="text-ink-3 font-normal"> (você)</span>}</div><div className="text-xs text-ink-3">{u.email}{u.phone ? ` · ${u.phone}` : ''}</div></Td>
                <Td><Badge tone={MATRIX.includes(u.role) ? 'yellow' : 'neutral'}>{u.roleLabel}</Badge></Td>
                <Td className="text-xs text-ink-2 max-w-56">{MATRIX.includes(u.role) ? 'Todas (Painel Matriz)' : u.stores.map((s: any) => s.name).join(', ') || <span className="text-warn">Nenhuma</span>}</Td>
                <Td>
                  {u.status === 'BLOCKED' ? <Badge tone="danger">Bloqueado</Badge> : !u.hasPassword ? <Badge tone="warn">Aguardando criar senha</Badge> : u.lockedUntil ? <Badge tone="warn">Bloqueio temporário</Badge> : <Badge tone="ok">Ativo</Badge>}
                </Td>
                <Td className="text-xs text-ink-3">{u.lastLoginAt ? relative(u.lastLoginAt) : 'Nunca entrou'}</Td>
                <Td className="text-right whitespace-nowrap">
                  {u.role === 'PROMOTER' && u.status === 'ACTIVE' && <Button variant="ghost" icon={<Smartphone className="size-4" />} title="Enviar o link do app Android para o divulgador" onClick={() => shareApp(u.name)}>Enviar app</Button>}
                  <Button variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(u)}>Editar</Button>
                  {u.id !== me?.id && (u.status === 'BLOCKED'
                    ? <Button variant="ghost" icon={<Unlock className="size-4" />} onClick={() => block(u, false)}>Liberar</Button>
                    : <Button variant="ghost" icon={<Lock className="size-4" />} onClick={() => block(u, true)}>Bloquear</Button>)}
                  {u.status === 'ACTIVE' && <Button variant="ghost" icon={<Send className="size-4" />} onClick={() => sendAccess(u)}>{u.hasPassword ? 'Redefinir senha' : 'Reenviar acesso'}</Button>}
                </Td>
              </tr>
            ))}
          </Table>
        ) : <EmptyState icon={<UsersIcon className="size-5" />} title="Nenhum usuário" />}
      </Card>
      <p className="text-xs text-ink-3 mt-3">Ninguém define a senha de outra pessoa: ao criar o usuário, ele recebe por e-mail um link para criar a própria senha. E-mails listados em DEVELOPER_EMAILS recebem automaticamente o perfil Desenvolvedor.</p>
      {editing && list.data && <UserForm user={editing === 'new' ? null : editing} roles={list.data.assignableRoles} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(true); }} />}
    </div>
  );
}

export function UserForm({ user, roles, onClose, onSaved, defaultStoreIds }: { user: any | null; roles: { value: string; label: string }[]; onClose: () => void; onSaved: () => void; defaultStoreIds?: string[] }) {
  const toast = useToast();
  const { stores } = useStores();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState(user?.role ?? 'PROMOTER');
  const [storeIds, setStoreIds] = useState<string[]>(user?.stores?.map((s: any) => s.id) ?? defaultStoreIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matrix = MATRIX.includes(role);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true); setError(null);
    try {
      const body: any = { name, email, role, storeIds: matrix ? [] : storeIds };
      if (phone) body.phone = phone;
      if (user) {
        await patch(`/api/users/${user.id}`, body);
        toast('ok', 'Usuário atualizado.');
      } else {
        const r = await post('/api/users', body);
        toast(r.inviteSent ? 'ok' : 'info', r.inviteSent ? `Usuário criado. O link para criar a senha foi enviado para ${email}.` : 'Usuário criado, mas o e-mail de acesso não pôde ser enviado. Confira o e-mail (SMTP) em Integração e use "Reenviar acesso".');
      }
      onSaved();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'); } finally { setBusy(false); }
  }

  return (
    <Drawer open onClose={onClose} title={user ? `Editar ${user.name}` : 'Novo usuário'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={() => submit()} disabled={!name || !email || (!matrix && !storeIds.length)}>Salvar</Button></>}>
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorBox>{error}</ErrorBox>}
        <Field label="Nome completo"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        <Field label="E-mail" hint="Usado para entrar e para receber o código de verificação."><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} /></Field>
        <Field label="Telefone (opcional)" hint={user?.phone ? `Atual: ${user.phone}. Preencha só para trocar.` : 'Só se for necessário para a operação.'}><Input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} /></Field>
        <Field label="Perfil">
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </Select>
        </Field>
        <Notice tone="info">
          {role === 'ADMIN' || role === 'DIRECTOR' ? 'Painel Matriz com todas as lojas, usuários, auditoria e tela Sistema. Não altera a infraestrutura.'
            : role === 'FRANCHISE_MANAGER' ? 'Gestor da franquia: todas as lojas e todos os percursos. Cadastra lojas, abre o painel de cada loja e cadastra/vincula as pessoas das lojas (gerentes e divulgadores).'
            : role === 'COORDINATOR' ? 'Painel Matriz com todas as lojas: territórios, campanhas, percursos e relatórios. Não gerencia usuários.'
            : role === 'STORE_MANAGER' ? 'Só as lojas marcadas abaixo: territórios, campanhas, percursos e relatórios dessas lojas.'
            : role === 'PROMOTER' ? 'Só o modo campo: inicia e encerra o rastreamento das campanhas para as quais for escolhido.'
            : 'Acesso completo, inclusive Integração e atualização do sistema.'}
        </Notice>
        {!matrix && (
          <div>
            <span className="block text-xs font-medium text-ink-2 mb-1.5">Lojas</span>
            <div className="space-y-2 max-h-60 overflow-y-auto scroll-thin rounded-xl border border-line p-3">
              {stores.map((s) => <Checkbox key={s.id} checked={storeIds.includes(s.id)} onChange={(v) => setStoreIds((l) => (v ? [...l, s.id] : l.filter((x) => x !== s.id)))} label={`${s.name} (${s.code})`} />)}
              {!stores.length && <p className="text-xs text-ink-3">Nenhuma loja cadastrada.</p>}
            </div>
          </div>
        )}
      </form>
    </Drawer>
  );
}
void Plus;
