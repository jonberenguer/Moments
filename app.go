package main

import (
	"context"
)

// App is the Wails backend. Methods bound here (via Bind in main.go) are callable
// from the frontend through the generated bindings in frontend/wailsjs/go/main.
//
// M2 will grow this into the full backend that reproduces the Electron
// window.electronAPI surface (fs, dialogs, prefs, fontPath, GPU detect, ffmpeg
// export/cancel). For M1 it is a minimal stub so the app compiles and renders.
type App struct {
	ctx context.Context
}

// NewApp creates a new App application struct.
func NewApp() *App {
	return &App{}
}

// startup stores the runtime context for later runtime calls (events, dialogs).
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// Ping is a trivial liveness method used to verify the Go<->JS bridge in M1.
func (a *App) Ping() string {
	return "moments-wails: backend alive"
}
