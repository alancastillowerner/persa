// Valores por defecto. Todo se puede cambiar desde el panel del streamer (se guarda en la tabla settings).
import { getSetting } from './util.js';

export const DEFAULT_PROFILE = {
  name: 'El Persa',
  site: 'La Grieta del Persa',
  tagline: 'Pronosticá sus partidas, juntá fichas y canjealas por premios',
  avatar: 'https://files.kick.com/images/user/2825079/profile_image/conversion/e69025b8-33c0-4a72-a8fd-54523245e44e-fullsize.webp',
  banner: '',
  kick: 'el_persa',
  twitch: '',
  twitter: 'ei_persa',
  discord: '',
  main_platform: 'kick',
};

export const DEFAULT_ECONOMY = {
  points_per_ficha: 100,      // 100 puntos de canal = 1 ficha
  packs: [1, 10, 50],         // recompensas que se crean en Twitch/Kick (1, 10 y 50 fichas)
  welcome_bonus: 50,          // fichas de regalo al registrarse
  base_reward: 10,            // premio base por acertar (se multiplica por la cuota)
  comodin_x2: 25,             // costo del comodín "Doble premio"
  comodin_escudo: 15,         // costo del comodín "Escudo"
};

export const DEFAULT_MARKETS = {
  pregame_close: 240,         // los pronósticos de partida cierran al minuto 4
  win: true,
  kills: true, kills_line: 5.5,
  deaths: true, deaths_line: 4.5,
  duration: true, duration_line: 30,
  firstblood: true,           // requieren la app de PC
  death10: true,
  firstdragon: true,
  ignore_modes: ['PRACTICETOOL', 'TUTORIAL'],
};

export const DEFAULT_RIOT = {
  game_name: '',
  tag_line: '',
  platform: 'la2',            // LAS = la2, LAN = la1, BR = br1, NA = na1
  region: 'americas',
  puuid: '',
};

export const DEFAULT_REWARDS = [
  { id: 'saludo', name: 'Saludo en vivo', description: 'El Persa te saluda en el stream con tu nombre.', cost: 300, icon: 'mic', needs_note: 0, note_hint: '' },
  { id: 'overlay', name: 'Tu nombre en pantalla', description: 'Aparecés en el overlay durante todo un stream.', cost: 150, icon: 'star', needs_note: 0, note_hint: '' },
  { id: 'campeon', name: 'Elegís el campeón', description: 'Decidís con qué campeón juega la próxima partida.', cost: 800, icon: 'crown', needs_note: 1, note_hint: '¿Qué campeón?' },
  { id: 'build', name: 'Elegís la build', description: 'Armás la build o las runas de una partida.', cost: 500, icon: 'sword', needs_note: 1, note_hint: 'Contanos la build o las runas' },
  { id: 'vip', name: 'Rol VIP en Discord', description: 'Rol especial en el Discord de la comunidad por un mes.', cost: 600, icon: 'gem', needs_note: 1, note_hint: 'Tu usuario de Discord' },
  { id: 'review', name: 'Revisión de tu partida', description: 'El Persa mira una partida tuya en vivo y te da consejos.', cost: 1500, icon: 'eye', needs_note: 1, note_hint: 'Tu Riot ID (nombre#tag)' },
  { id: 'duo', name: 'Partida con El Persa', description: 'Jugás una partida normal o ARAM con él.', cost: 3000, icon: 'shield', needs_note: 1, note_hint: 'Tu Riot ID (nombre#tag)' },
];

export async function getConfig(env) {
  const [profile, economy, markets, riot] = await Promise.all([
    getSetting(env, 'profile', {}),
    getSetting(env, 'economy', {}),
    getSetting(env, 'markets_cfg', {}),
    getSetting(env, 'riot', {}),
  ]);
  return {
    profile: { ...DEFAULT_PROFILE, ...profile },
    economy: { ...DEFAULT_ECONOMY, ...economy },
    markets: { ...DEFAULT_MARKETS, ...markets },
    riot: { ...DEFAULT_RIOT, ...riot },
  };
}
