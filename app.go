package main

import (
	"context"
	goruntime "runtime"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the Wails backend. Every exported method on *App is bound (see Bind in
// main.go) and callable from the frontend via window.go.main.App.<Method>. The
// frontend does not call these directly — src/wailsShim.js maps the Electron
// window.electronAPI surface onto them (see electron-app-legacy/electron/preload.js
// for the original contract).
type App struct {
	ctx        context.Context
	forceClose bool      // set by ForceClose() so onBeforeClose lets the window go
	gpuCache   *GPUCaps  // detectGPU result, cached per session
}

// NewApp creates a new App application struct.
func NewApp() *App {
	return &App{}
}

// startup stores the runtime context for later runtime calls (events, dialogs)
// and registers the native OS file-drop handler.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	// Native OS file drops (HTML drag-drop of OS files can't expose paths in a
	// webview). Wails delivers the real paths here; we filter to media and emit
	// them to the frontend as import entries (same shape as OpenFilesDialog), so
	// the store adds them to the library. Internal library→timeline DnD is DOM
	// drag-drop and is unaffected.
	wruntime.OnFileDrop(ctx, func(x, y int, paths []string) {
		entries := make([]MediaEntry, 0, len(paths))
		for _, p := range paths {
			if isAcceptableMedia(p) {
				entries = append(entries, entryFor(p))
			}
		}
		if len(entries) > 0 {
			wruntime.EventsEmit(ctx, "files:dropped", entries)
		}
	})
}

// Platform returns an Electron-style platform string so the frontend's existing
// checks (window.electronAPI.platform === 'win32' / !== 'linux') keep working.
func (a *App) Platform() string {
	switch goruntime.GOOS {
	case "windows":
		return "win32"
	case "darwin":
		return "darwin"
	default:
		return "linux"
	}
}

// ── Window close (mirrors the Electron confirm-close flow) ────────────────────
// The Electron main process intercepted the window 'close', asked the renderer
// (onConfirmClose), and closed only after ForceClose(). Wails' OnBeforeClose is
// the equivalent hook.

// onBeforeClose is wired via options.App.OnBeforeClose in main.go. Returning true
// prevents the close; we emit the confirm-close event and wait for ForceClose().
// (M5 will add the wedged-renderer watchdog + killAllExports.)
func (a *App) onBeforeClose(ctx context.Context) bool {
	if a.forceClose {
		return false // allow close
	}
	wruntime.EventsEmit(ctx, "app:confirm-close")
	return true // prevent close; renderer shows the exit dialog
}

// ForceClose is called by the renderer once the user confirms exit.
func (a *App) ForceClose() {
	a.forceClose = true
	wruntime.Quit(a.ctx)
}

// ConfirmCloseAck is the renderer's "I'm alive and showing the dialog" ack. The
// close watchdog that consumes it lands in M5; kept now so the shim can call it.
func (a *App) ConfirmCloseAck() {}
