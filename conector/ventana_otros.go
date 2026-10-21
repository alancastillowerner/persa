//go:build !windows

package main

import (
	"errors"
	"fmt"
	"os/exec"
	"runtime"
)

// En Linux/Mac solo se usa para pruebas: abre el navegador por defecto.
func abrirVentana(url string) {
	fmt.Println("Interfaz del conector:", url)
	abrirNavegador(url)
}

func abrirNavegador(url string) {
	cmd := "xdg-open"
	if runtime.GOOS == "darwin" {
		cmd = "open"
	}
	_ = exec.Command(cmd, url).Start()
}

func abrirArchivo(ruta string) { abrirNavegador(ruta) }

func configurarAutoInicio(on bool, exe string) error {
	if on {
		return errors.New("el inicio automático solo está disponible en Windows")
	}
	return nil
}

func mostrarError(msg string) { fmt.Println(msg) }
