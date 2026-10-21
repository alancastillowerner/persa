// GrietaConector: lee la partida en vivo de League of Legends y la manda a La Grieta del Persa.
// Un solo .exe, sin instalación. La interfaz es una ventana local (Edge en modo app).
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	version   = "1.0.0"
	puertoUI  = "127.0.0.1:47823"
	urlLiga   = "https://127.0.0.1:2999/liveclientdata/allgamedata"
	nombreApp = "GrietaConector"
)

type Config struct {
	Codigo     string `json:"codigo"`
	Servidor   string `json:"servidor"`
	Clave      string `json:"clave"`
	Sitio      string `json:"sitio"`
	Streamer   string `json:"streamer"`
	AutoInicio bool   `json:"autoinicio"`
}

type LineaLog struct {
	T   int64  `json:"t"`
	Msg string `json:"msg"`
	Err bool   `json:"err"`
}

type Partida struct {
	Campeon    string  `json:"campeon"`
	CampeonKey string  `json:"campeonKey"`
	Tiempo     float64 `json:"tiempo"`
	Kills      int     `json:"k"`
	Deaths     int     `json:"d"`
	Assists    int     `json:"a"`
	Modo       string  `json:"modo"`
	Equipo     string  `json:"equipo"`
}

// Estado que ve la interfaz
type Estado struct {
	Configurado    bool       `json:"configurado"`
	Sitio          string     `json:"sitio"`
	Streamer       string     `json:"streamer"`
	Servidor       string     `json:"servidor"`
	Conectado      bool       `json:"conectado"`
	UltimoContacto int64      `json:"ultimoContacto"`
	ErrorServidor  string     `json:"errorServidor"`
	Liga           string     `json:"liga"` // cerrado | cargando | en_partida | terminada
	Partida        *Partida   `json:"partida"`
	Abiertos       int        `json:"abiertos"`
	Eventos        int        `json:"eventos"`
	Ignorada       string     `json:"ignorada"`
	Version        string     `json:"version"`
	AutoInicio     bool       `json:"autoinicio"`
	Log            []LineaLog `json:"log"`
}

var (
	mu        sync.Mutex
	cfg       Config
	est       = Estado{Liga: "cerrado", Version: version}
	dirConfig string
	tokenUI   string
	logFile   *os.File
	flagLiga  = flag.String("liga", urlLiga, "URL de la Live Client Data API (pruebas)")
	flagSinV  = flag.Bool("sinventana", false, "arrancar sin abrir la ventana (inicio con Windows)")
	flagCod   = flag.String("codigo", "", "código de conexión (pruebas)")
	flagDir   = flag.String("datos", "", "carpeta de datos (pruebas)")
)

func registrar(err bool, format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	mu.Lock()
	est.Log = append(est.Log, LineaLog{T: time.Now().UnixMilli(), Msg: msg, Err: err})
	if len(est.Log) > 80 {
		est.Log = est.Log[len(est.Log)-80:]
	}
	mu.Unlock()
	log.Println(msg)
}

func guardarConfig() error {
	mu.Lock()
	b, _ := json.MarshalIndent(cfg, "", "  ")
	mu.Unlock()
	return os.WriteFile(filepath.Join(dirConfig, "config.json"), b, 0o600)
}

func cargarConfig() {
	b, err := os.ReadFile(filepath.Join(dirConfig, "config.json"))
	if err == nil {
		_ = json.Unmarshal(b, &cfg)
	}
}

// El código del panel es "GRIETA-" + base64url({"u": servidor, "k": clave, "n": nombre del sitio})
func decodificarCodigo(codigo string) (servidor, clave, sitio string, err error) {
	c := strings.TrimSpace(codigo)
	c = strings.TrimPrefix(c, "GRIETA-")
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(c, "="))
	if err != nil {
		return "", "", "", errors.New("el código no es válido: copialo completo desde el panel")
	}
	var d struct {
		U string `json:"u"`
		K string `json:"k"`
		N string `json:"n"`
	}
	if json.Unmarshal(raw, &d) != nil || d.U == "" || d.K == "" {
		return "", "", "", errors.New("el código no es válido: copialo completo desde el panel")
	}
	return strings.TrimRight(d.U, "/"), d.K, d.N, nil
}

func aplicarCodigo(codigo string) error {
	srv, clave, sitio, err := decodificarCodigo(codigo)
	if err != nil {
		return err
	}
	nombre, err := probarServidor(srv, clave)
	if err != nil {
		return err
	}
	mu.Lock()
	cfg.Codigo, cfg.Servidor, cfg.Clave, cfg.Sitio, cfg.Streamer = codigo, srv, clave, sitio, nombre
	est.Configurado, est.Servidor, est.Sitio, est.Streamer = true, srv, sitio, nombre
	est.Conectado, est.ErrorServidor, est.UltimoContacto = true, "", time.Now().UnixMilli()
	mu.Unlock()
	registrar(false, "Conectado a %s", srv)
	return guardarConfig()
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Si ya hay un conector abierto, solo se abre su ventana.
func yaEstaCorriendo() bool {
	c := http.Client{Timeout: 1500 * time.Millisecond}
	r, err := c.Get("http://" + puertoUI + "/salud")
	if err != nil {
		return false
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	return strings.Contains(string(b), nombreApp)
}

func main() {
	flag.Parse()
	base, err := os.UserConfigDir()
	if err != nil {
		base = "."
	}
	dirConfig = filepath.Join(base, nombreApp)
	if *flagDir != "" {
		dirConfig = *flagDir
	}
	_ = os.MkdirAll(dirConfig, 0o700)

	logPath := filepath.Join(dirConfig, "registro.txt")
	if fi, err := os.Stat(logPath); err == nil && fi.Size() > 2<<20 {
		_ = os.Remove(logPath)
	}
	logFile, _ = os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if logFile != nil {
		log.SetOutput(logFile)
	}

	ln, err := net.Listen("tcp", puertoUI)
	if err != nil {
		if yaEstaCorriendo() {
			abrirVentana("http://" + puertoUI + "/")
			return
		}
		mostrarError("No se pudo iniciar GrietaConector: el puerto 47823 está ocupado por otro programa.")
		return
	}

	cargarConfig()
	tokenUI = randomHex(16)
	mu.Lock()
	est.Configurado = cfg.Servidor != "" && cfg.Clave != ""
	est.Servidor, est.Sitio, est.Streamer, est.AutoInicio = cfg.Servidor, cfg.Sitio, cfg.Streamer, cfg.AutoInicio
	mu.Unlock()
	registrar(false, "GrietaConector %s iniciado", version)

	if *flagCod != "" {
		if err := aplicarCodigo(*flagCod); err != nil {
			registrar(true, "Código: %v", err)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go bucle(ctx)

	srv := &http.Server{Handler: rutasUI(cancel), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if !*flagSinV {
			time.Sleep(300 * time.Millisecond)
			abrirVentana("http://" + puertoUI + "/")
		}
	}()
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	_ = srv.Serve(ln)
	registrar(false, "Conector apagado")
}
