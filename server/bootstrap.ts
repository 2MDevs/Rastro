import bcrypt from 'bcryptjs';
import { pool } from './db';
import { newId } from './auth/core';
import { writeAuditRaw } from './audit';

/**
 * Administrador inicial ("usuário fantasma"), igual ao DocSecure: criado a partir de ADMIN_EMAIL e
 * ADMIN_INITIAL_PASSWORD com o perfil Desenvolvedor (vê Integração e o botão "Atualizar sistema"),
 * só quando ainda não existe nenhum administrador/desenvolvedor. Troca de senha obrigatória no 1º login.
 */
export async function ensureInitialAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_INITIAL_PASSWORD || '';
  const { rows } = await pool.query(`SELECT 1 FROM users WHERE role IN ('ADMIN','DEVELOPER','DIRECTOR') LIMIT 1`);
  if (rows.length) return;
  if (!email || !password) {
    console.warn('[RASTRO] Nenhum administrador cadastrado. Defina ADMIN_EMAIL e ADMIN_INITIAL_PASSWORD no .env para o primeiro acesso.');
    return;
  }
  if (password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    console.error('[RASTRO] ADMIN_INITIAL_PASSWORD precisa ter pelo menos 10 caracteres, com letras e números. Administrador inicial NÃO criado.');
    return;
  }
  const id = newId('usr');
  await pool.query(
    `INSERT INTO users (id, name, email, role, password_hash, must_change_password) VALUES ($1, $2, $3, 'DEVELOPER', $4, true)
     ON CONFLICT DO NOTHING`,
    [id, 'Administrador inicial', email, await bcrypt.hash(password, 12)]
  );
  await writeAuditRaw({ id: null, name: 'Sistema', role: 'SYSTEM' },
    { action: 'USER_CREATED', targetType: 'user', targetId: id, targetName: email, details: 'Administrador inicial criado a partir do .env com perfil Desenvolvedor (troca de senha obrigatória).' },
    { ip: 'servidor', device: 'Inicialização' });
  console.log(`[RASTRO] Administrador inicial criado: ${email} (troca de senha obrigatória no primeiro acesso).`);
}
