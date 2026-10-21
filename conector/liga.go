package main

import (
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// ---------- Datos de la Live Client Data API (https://127.0.0.1:2999) ----------
type jugadorLiga struct {
	ChampionName    string `json:"championName"`
	RawChampionName string `json:"rawChampionName"`
	RiotID          string `json:"riotId"`
	RiotIDGameName  string `json:"riotIdGameName"`
	SummonerName    string `json:"summonerName"`
	Team            string `json:"team"`
	Scores          struct {
		Kills      int `json:"kills"`
		Deaths     int `json:"deaths"`
		Assists    int `json:"assists"`
		CreepScore int `json:"creepScore"`
	} `json:"scores"`
}

type datosLiga struct {
	ActivePlayer struct {
		RiotID         string `json:"riotId"`
		RiotIDGameName string `json:"riotIdGameName"`
		SummonerName   string `json:"summonerName"`
	} `json:"activePlayer"`
	AllPlayers []jugadorLiga `json:"allPlayers"`
	Events     struct {
		Events []map[string]any `json:"Events"`
	} `json:"events"`
	GameData struct {
		GameMode string  `json:"gameMode"`
		GameTime float64 `json:"gameTime"`
	} `json:"gameData"`
}

// El cliente de League usa un certificado propio de Riot: solo para 127.0.0.1 se acepta sin verificar.
var clienteLiga = &http.Client{
	Timeout: 2 * time.Second,
	Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // solo localhost:2999
		Proxy:           nil,
	},
}

var clienteServidor = &http.Client{Timeout: 10 * time.Second}

var errCargando = errors.New("cargando")

func leerLiga() (*datosLiga, error) {
	r, err := clienteLiga.Get(*flagLiga)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return nil, errCargando // pantalla de carga: el juego responde pero todavía no hay datos
	}
	var d datosLiga
	if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
		return nil, errCargando
	}
	if len(d.AllPlayers) == 0 {
		return nil, errCargando
	}
	return &d, nil
}

func nombres(vals ...string) []string {
	out := []string{}
	for _, v := range vals {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func claveCampeon(raw string) string {
	return strings.TrimPrefix(raw, "game_character_displayname_")
}

// Identificador estable de la partida: mismo resultado aunque se reinicie la app a mitad de partida.
func sesionDe(d *datosLiga) string {
	partes := []string{d.GameData.GameMode}
	for _, p := range d.AllPlayers {
		partes = append(partes, p.Team+"|"+p.RawChampionName+"|"+strings.ToLower(p.RiotID+p.SummonerName))
	}
	sort.Strings(partes)
	h := sha1.Sum([]byte(strings.Join(partes, ";")))
	return hex.EncodeToString(h[:])[:20]
}

// ---------- Envío al servidor ----------
type respuestaSync struct {
	OK       bool   `json:"ok"`
	Error    string `json:"error"`
	Ignored  string `json:"ignored"`
	Streamer string `json:"streamer"`
	Site     string `json:"site"`
	Game     *struct {
		ID          string `json:"id"`
		Status      string `json:"status"`
		OpenMarkets int    `json:"open_markets"`
	} `json:"game"`
}

func postServidor(srv, clave, ruta string, body any) (*respuestaSync, error) {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", srv+ruta, bytes.NewReader(b))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+clave)
	req.Header.Set("user-agent", nombreApp+"/"+version)
	r, err := clienteServidor.Do(req)
	if err != nil {
		return nil, fmt.Errorf("sin conexión con la web (%v)", recortar(err.Error(), 80))
	}
	defer r.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	var res respuestaSync
	if json.Unmarshal(raw, &res) != nil {
		return nil, fmt.Errorf("la web respondió algo inesperado (HTTP %d)", r.StatusCode)
	}
	if r.StatusCode == 401 {
		return nil, errors.New("el código de conexión ya no es válido: generá uno nuevo en el panel")
	}
	if !res.OK {
		return &res, errors.New(res.Error)
	}
	return &res, nil
}

func probarServidor(srv, clave string) (string, error) {
	res, err := postServidor(srv, clave, "/api/app/sync", map[string]any{"version": version, "game": nil})
	if err != nil {
		return "", err
	}
	return res.Streamer, nil
}

func recortar(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

// ---------- Bucle principal ----------
func bucle(ctx context.Context) {
	var (
		sesion        string
		ultimoEvento  = -1
		terminada     = map[string]bool{}
		ultimoEnvio   time.Time
		estabaEnJuego bool
	)
	tick := time.NewTicker(1 * time.Second)
	defer tick.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}

		mu.Lock()
		srv, clave := cfg.Servidor, cfg.Clave
		mu.Unlock()

		d, err := leerLiga()
		var juego map[string]any
		nuevos := false

		switch {
		case err == nil:
			s := sesionDe(d)
			if s != sesion {
				sesion, ultimoEvento = s, -1
				registrar(false, "Partida detectada (%s)", d.GameData.GameMode)
			}
			eventos := []map[string]any{}
			for _, ev := range d.Events.Events {
				id := int(toFloat(ev["EventID"]))
				if id > ultimoEvento {
					eventos = append(eventos, ev)
					nuevos = true
				}
			}
			jugadores := []map[string]any{}
			var yo *jugadorLiga
			misNombres := nombres(d.ActivePlayer.RiotID, d.ActivePlayer.RiotIDGameName, d.ActivePlayer.SummonerName)
			for i, p := range d.AllPlayers {
				ns := nombres(p.RiotID, p.RiotIDGameName, p.SummonerName)
				for _, a := range ns {
					for _, b := range misNombres {
						if strings.EqualFold(strings.Split(a, "#")[0], strings.Split(b, "#")[0]) {
							yo = &d.AllPlayers[i]
						}
					}
				}
				jugadores = append(jugadores, map[string]any{
					"names": ns, "team": p.Team, "champion": p.ChampionName, "champion_key": claveCampeon(p.RawChampionName),
					"kills": p.Scores.Kills, "deaths": p.Scores.Deaths, "assists": p.Scores.Assists, "cs": p.Scores.CreepScore,
				})
			}
			juego = map[string]any{
				"session": sesion, "gameTime": d.GameData.GameTime, "mode": d.GameData.GameMode,
				"active": map[string]any{"names": misNombres}, "players": jugadores, "events": eventos,
			}
			mu.Lock()
			if terminada[sesion] {
				est.Liga = "terminada"
			} else {
				est.Liga = "en_partida"
			}
			if yo != nil {
				est.Partida = &Partida{Campeon: yo.ChampionName, CampeonKey: claveCampeon(yo.RawChampionName), Tiempo: d.GameData.GameTime,
					Kills: yo.Scores.Kills, Deaths: yo.Scores.Deaths, Assists: yo.Scores.Assists, Modo: d.GameData.GameMode, Equipo: yo.Team}
			}
			mu.Unlock()
			if !estabaEnJuego {
				estabaEnJuego = true
			}
		case errors.Is(err, errCargando):
			mu.Lock()
			est.Liga = "cargando"
			mu.Unlock()
		default:
			mu.Lock()
			avisar := est.Liga != "cerrado" && estabaEnJuego
			est.Liga, est.Partida = "cerrado", nil
			mu.Unlock()
			if avisar {
				registrar(false, "League cerró la partida")
			}
			estabaEnJuego = false
		}

		if srv == "" || clave == "" {
			continue
		}
		// Ritmo: con partida, cada 2 s (o al instante si hay eventos nuevos); sin partida, latido cada 15 s.
		espera := 15 * time.Second
		if juego != nil && !terminada[sesion] {
			espera = 2 * time.Second
			if nuevos {
				espera = 0
			}
		}
		if time.Since(ultimoEnvio) < espera {
			continue
		}
		ultimoEnvio = time.Now()

		body := map[string]any{"version": version, "game": nil}
		if juego != nil && !terminada[sesion] {
			body["game"] = juego
		}
		res, err := postServidor(srv, clave, "/api/app/sync", body)
		mu.Lock()
		if err != nil {
			if est.Conectado || est.ErrorServidor != err.Error() {
				mu.Unlock()
				registrar(true, "%v", err)
				mu.Lock()
			}
			est.Conectado, est.ErrorServidor = false, err.Error()
			mu.Unlock()
			continue
		}
		if !est.Conectado {
			mu.Unlock()
			registrar(false, "Conexión con la web OK")
			mu.Lock()
		}
		est.Conectado, est.ErrorServidor, est.UltimoContacto = true, "", time.Now().UnixMilli()
		if res.Streamer != "" {
			est.Streamer = res.Streamer
		}
		if res.Site != "" {
			est.Sitio = res.Site
		}
		est.Ignorada = res.Ignored
		if body["game"] != nil {
			evs := juego["events"].([]map[string]any)
			for _, ev := range evs {
				if id := int(toFloat(ev["EventID"])); id > ultimoEvento {
					ultimoEvento = id
				}
			}
			est.Eventos += len(evs)
			if res.Game != nil {
				est.Abiertos = res.Game.OpenMarkets
				if res.Game.Status == "ended" && !terminada[sesion] {
					terminada[sesion] = true
					est.Liga, est.Abiertos = "terminada", 0
					mu.Unlock()
					registrar(false, "Partida terminada: los pronósticos se resolvieron")
					mu.Lock()
				}
			}
		} else {
			est.Abiertos = 0
		}
		mu.Unlock()
	}
}

func toFloat(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case json.Number:
		f, _ := x.Float64()
		return f
	}
	return -1
}
