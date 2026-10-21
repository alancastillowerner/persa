# Simula la Live Client Data API de League of Legends (https://127.0.0.1:29990) para probar el conector.
# Uso: python3 liga_falsa.py [segundos_por_minuto]
# Arranca con 3 s de pantalla de carga, después la partida avanza rápido con eventos reales de ejemplo.
import json, ssl, sys, time, subprocess, os, tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VEL = float(sys.argv[1]) if len(sys.argv) > 1 else 60.0  # segundos de juego por segundo real
INICIO = time.time()
CARGA = 3.0

JUG = [
    ('El Persa', 'LAS', 'Ahri', 'ORDER'), ('Aliado1', 'LAS', 'Garen', 'ORDER'), ('Aliado2', 'LAS', 'Lux', 'ORDER'),
    ('Aliado3', 'LAS', 'Jinx', 'ORDER'), ('Aliado4', 'LAS', 'Thresh', 'ORDER'),
    ('Rival1', 'LAS', 'Zed', 'CHAOS'), ('Rival2', 'LAS', 'Caitlyn', 'CHAOS'), ('Rival3', 'LAS', 'Leona', 'CHAOS'),
    ('Rival4', 'LAS', 'LeeSin', 'CHAOS'), ('Rival5', 'LAS', 'Darius', 'CHAOS'),
]
# (segundo de juego, evento)
GUION = [
    (0.05, {'EventName': 'GameStart'}),
    (65, {'EventName': 'MinionsSpawning'}),
    (150, {'EventName': 'FirstBlood', 'Recipient': 'El Persa'}),
    (150, {'EventName': 'ChampionKill', 'KillerName': 'El Persa', 'VictimName': 'Rival1', 'Assisters': []}),
    (420, {'EventName': 'ChampionKill', 'KillerName': 'Rival4', 'VictimName': 'El Persa', 'Assisters': []}),
    (380, {'EventName': 'DragonKill', 'KillerName': 'Aliado3', 'DragonType': 'Fire', 'Stolen': 'False'}),
    (900, {'EventName': 'ChampionKill', 'KillerName': 'El Persa', 'VictimName': 'Rival2', 'Assisters': []}),
    (1200, {'EventName': 'ChampionKill', 'KillerName': 'El Persa', 'VictimName': 'Rival3', 'Assisters': []}),
    (1500, {'EventName': 'ChampionKill', 'KillerName': 'El Persa', 'VictimName': 'Rival5', 'Assisters': []}),
    (1700, {'EventName': 'ChampionKill', 'KillerName': 'El Persa', 'VictimName': 'Rival1', 'Assisters': []}),
    (1850, {'EventName': 'ChampionKill', 'KillerName': 'El Persa', 'VictimName': 'Rival4', 'Assisters': []}),
    (1860, {'EventName': 'ChampionKill', 'KillerName': 'El Persa', 'VictimName': 'Rival2', 'Assisters': []}),
    (1890, {'EventName': 'GameEnd', 'Result': 'Win'}),
]

def datos():
    t = (time.time() - INICIO - CARGA) * VEL
    if t < 0:
        return None
    t = min(t, 1895)
    evs = sorted([(s, e) for s, e in GUION if s <= t], key=lambda x: x[0])
    eventos = [dict(e, EventID=i, EventTime=s) for i, (s, e) in enumerate(evs)]
    kills = sum(1 for e in eventos if e['EventName'] == 'ChampionKill' and e.get('KillerName') == 'El Persa')
    deaths = sum(1 for e in eventos if e['EventName'] == 'ChampionKill' and e.get('VictimName') == 'El Persa')
    jugadores = []
    for n, tag, c, team in JUG:
        sc = {'kills': kills if n == 'El Persa' else 1, 'deaths': deaths if n == 'El Persa' else 2, 'assists': 3, 'creepScore': int(t / 9)}
        jugadores.append({'championName': c, 'rawChampionName': f'game_character_displayname_{c}', 'riotId': f'{n}#{tag}',
                          'riotIdGameName': n, 'summonerName': f'{n}#{tag}', 'team': team, 'scores': sc})
    return {'activePlayer': {'riotId': 'El Persa#LAS', 'riotIdGameName': 'El Persa', 'summonerName': 'El Persa#LAS'},
            'allPlayers': jugadores, 'events': {'Events': eventos}, 'gameData': {'gameMode': 'CLASSIC', 'gameTime': t}}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        d = datos()
        if d is None:
            self.send_response(404); self.end_headers(); self.wfile.write(b'{"errorCode":"RESOURCE_NOT_FOUND"}'); return
        b = json.dumps(d).encode()
        self.send_response(200); self.send_header('content-type', 'application/json'); self.end_headers(); self.wfile.write(b)

tmp = tempfile.mkdtemp()
crt, key = os.path.join(tmp, 'c.pem'), os.path.join(tmp, 'k.pem')
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '1', '-subj', '/CN=127.0.0.1'], check=True, capture_output=True)
srv = ThreadingHTTPServer(('127.0.0.1', 29990), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(crt, key)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
print('Liga falsa en https://127.0.0.1:29990/liveclientdata/allgamedata', flush=True)
srv.serve_forever()
