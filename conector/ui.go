package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed ui/index.html
var paginaUI string

//go:embed ui/icono.svg
var iconoUI string

func responderJSON(w http.ResponseWriter, v any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

// Solo acepta pedidos desde la propia ventana: host local y token de la sesión (evita que una web externa toque el conector).
func autorizado(r *http.Request) bool {
	if r.Host != puertoUI {
		return false
	}
	if r.Method == http.MethodPost && r.Header.Get("x-token") != tokenUI {
		return false
	}
	return true
}

func rutasUI(apagar context.CancelFunc) http.Handler {
	m := http.NewServeMux()

	m.HandleFunc("/salud", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(nombreApp))
	})

	m.HandleFunc("/icono.svg", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "image/svg+xml")
		_, _ = w.Write([]byte(iconoUI))
	})

	m.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" || !autorizado(r) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("content-type", "text/html; charset=utf-8")
		w.Header().Set("cache-control", "no-store")
		w.Header().Set("content-security-policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'")
		_, _ = w.Write([]byte(strings.Replace(paginaUI, "__TOKEN__", tokenUI, 1)))
	})

	m.HandleFunc("/api/estado", func(w http.ResponseWriter, r *http.Request) {
		if !autorizado(r) {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		mu.Lock()
		e := est
		e.Log = append([]LineaLog(nil), est.Log...)
		mu.Unlock()
		responderJSON(w, e)
	})

	post := func(ruta string, fn func(w http.ResponseWriter, r *http.Request)) {
		m.HandleFunc(ruta, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost || !autorizado(r) {
				http.Error(w, "no", http.StatusForbidden)
				return
			}
			fn(w, r)
		})
	}

	post("/api/codigo", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Codigo string `json:"codigo"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		if err := aplicarCodigo(b.Codigo); err != nil {
			responderJSON(w, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		responderJSON(w, map[string]any{"ok": true})
	})

	post("/api/olvidar", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		cfg.Codigo, cfg.Servidor, cfg.Clave = "", "", ""
		est.Configurado, est.Conectado, est.Servidor, est.ErrorServidor = false, false, "", ""
		mu.Unlock()
		_ = guardarConfig()
		registrar(false, "Código borrado")
		responderJSON(w, map[string]any{"ok": true})
	})

	post("/api/autoinicio", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			On bool `json:"on"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		exe, _ := os.Executable()
		if err := configurarAutoInicio(b.On, exe); err != nil {
			responderJSON(w, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		mu.Lock()
		cfg.AutoInicio, est.AutoInicio = b.On, b.On
		mu.Unlock()
		_ = guardarConfig()
		if b.On {
			registrar(false, "Se va a abrir solo al iniciar Windows")
		} else {
			registrar(false, "Ya no se abre al iniciar Windows")
		}
		responderJSON(w, map[string]any{"ok": true})
	})

	post("/api/abrir-web", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Ruta string `json:"ruta"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		mu.Lock()
		srv := cfg.Servidor
		mu.Unlock()
		if srv != "" && (b.Ruta == "/" || b.Ruta == "/panel.html") {
			abrirNavegador(srv + b.Ruta)
		}
		responderJSON(w, map[string]any{"ok": true})
	})

	post("/api/registro", func(w http.ResponseWriter, r *http.Request) {
		abrirArchivo(filepath.Join(dirConfig, "registro.txt"))
		responderJSON(w, map[string]any{"ok": true})
	})

	post("/api/salir", func(w http.ResponseWriter, r *http.Request) {
		responderJSON(w, map[string]any{"ok": true})
		go func() {
			time.Sleep(300 * time.Millisecond)
			apagar()
		}()
	})

	return m
}
