//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const sinConsola = 0x08000000 // CREATE_NO_WINDOW

func ocultar(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: sinConsola}
}

// Edge viene con Windows 10 y 11; si no está, se prueba con Chrome y si no, el navegador por defecto.
func navegadorApp() string {
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LocalAppData"} {
		base := os.Getenv(env)
		if base == "" {
			continue
		}
		for _, c := range []string{
			filepath.Join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"),
		} {
			if _, err := os.Stat(c); err == nil {
				return c
			}
		}
	}
	return ""
}

func abrirVentana(url string) {
	if exe := navegadorApp(); exe != "" {
		c := exec.Command(exe, "--app="+url, "--window-size=520,820",
			"--user-data-dir="+filepath.Join(dirConfig, "ventana"),
			"--no-first-run", "--no-default-browser-check", "--disable-features=Translate,msEdgeSidebarV2")
		if c.Start() == nil {
			return
		}
	}
	abrirNavegador(url)
}

func abrirNavegador(url string) {
	c := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	ocultar(c)
	_ = c.Start()
}

func abrirArchivo(ruta string) {
	_ = exec.Command("notepad.exe", ruta).Start()
}

func configurarAutoInicio(on bool, exe string) error {
	const clave = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
	var c *exec.Cmd
	if on {
		c = exec.Command("reg", "add", clave, "/v", nombreApp, "/t", "REG_SZ", "/d", `"`+exe+`" -sinventana`, "/f")
	} else {
		c = exec.Command("reg", "delete", clave, "/v", nombreApp, "/f")
	}
	ocultar(c)
	out, err := c.CombinedOutput()
	if err != nil && on {
		return fmt.Errorf("no se pudo activar el inicio con Windows: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

func mostrarError(msg string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	box := user32.NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(nombreApp)
	m, _ := syscall.UTF16PtrFromString(msg)
	_, _, _ = box.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), 0x10)
}
