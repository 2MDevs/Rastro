import { Router } from 'express';
import express from 'express';
import fs from 'fs';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { h, HttpError } from '../http';
import { requireAuth, userOf } from '../auth/core';
import { can } from '../access';
import { getValue } from '../settings';
import { geocode } from '../services/osm';
import { BASEMAP_DIR } from './system';

export const mapRouter = Router();
mapRouter.use(requireAuth());

/** Mapa gratuito: estilos públicos do OpenFreeMap (dados OpenStreetMap), sem chave de acesso */
const FREE_STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/liberty';
const FREE_STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';

/** O que o mapa da tela deve usar como fundo (ou que não há mapa de fundo configurado) */
mapRouter.get('/config', h(async (_req, res) => {
  const styleUrl = await getValue('BASEMAP_STYLE_URL');
  const file = await getValue('BASEMAP_PMTILES_FILE');
  let basemap: any = null;
  let problem: string | null = null;
  if (styleUrl) basemap = { type: 'style', url: styleUrl };
  else if (file && fs.existsSync(path.join(BASEMAP_DIR, file))) {
    basemap = { type: 'pmtiles', url: `/basemap/${encodeURIComponent(file)}` };
  } else {
    // Mapa gratuito padrão (OpenFreeMap): funciona sem cadastro, sem chave e sem gerar arquivo
    basemap = { type: 'style', url: FREE_STYLE_LIGHT, darkUrl: FREE_STYLE_DARK, free: true };
    if (file) problem = `O arquivo ${file} não foi encontrado no servidor. Usando o mapa gratuito (OpenFreeMap).`;
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    basemap, problem,
    attribution: basemap?.free ? '© OpenFreeMap · © colaboradores do OpenStreetMap' : '© colaboradores do OpenStreetMap',
    glyphs: '/map-assets/fonts/{fontstack}/{range}.pbf',
  });
}));

const geocodeLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas buscas seguidas. Aguarde um minuto.' } });

mapRouter.get('/geocode', geocodeLimiter, h(async (req, res) => {
  const user = userOf(req);
  if (!can(user.role, 'stores.manage') && !can(user.role, 'territory.manage')) throw new HttpError(403, 'Você não tem permissão para esta busca.');
  const q = String(req.query.q || '').trim();
  if (q.length < 4) throw new HttpError(400, 'Digite pelo menos 4 letras do endereço.');
  return res.json(await geocode(q.slice(0, 200)));
}));

/** Arquivo do mapa de fundo (.pmtiles), com suporte a pedidos parciais (Range) e só para quem está logado */
export const basemapRouter = Router();
basemapRouter.use(requireAuth());
basemapRouter.use(express.static(BASEMAP_DIR, {
  index: false, dotfiles: 'deny', fallthrough: false, acceptRanges: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'private, max-age=86400'),
}));
