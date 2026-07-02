package main

import (
	"context"
	goruntime "runtime"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/options"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the Wails backend. Every exported method on *App is bound (see Bind in
// main.go) and callable from the frontend via window.go.main.App.<Method>. The
// frontend does not call these directly — src/wailsShim.js maps the Electron
// window.electronAPI surface onto them (see electron-app-legacy/electron/preload.js
// for the original contract).
type App struct {
	ctx        context.Context
	forceClose bool     // set by ForceClose() so onBeforeClose lets the window go
	gpuCache   *GPUCaps // detectGPU result, cached per session
	mediaBase  string   // loopback media server base URL (http://127.0.0.1:port)

	watchdogMu    sync.Mutex
	closeWatchdog *time.Timer // force-closes if the renderer never acks (wedged)
}

// NewApp creates a new App application struct. mediaBase is the loopback media
// server URL the frontend prefixes onto media paths (see media.go / wailsShim).
func NewApp(mediaBase string) *App {
	return &App{mediaBase: mediaBase}
}

// MediaBase returns the loopback media server base URL (http://127.0.0.1:port).
// The frontend builds media element src as <MediaBase>/media/<base64url(path)>.
func (a *App) MediaBase() string {
	return a.mediaBase
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

// onShutdown (wired via options.App.OnShutdown) — belt-and-suspenders so no
// FFmpeg child outlives the app on any quit path.
func (a *App) onShutdown(ctx context.Context) {
	killAllExports()
}

// onSecondInstance (wired via SingleInstanceLock) focuses the existing window
// when a second launch is attempted, instead of spinning up a rival process.
func (a *App) onSecondInstance(_ options.SecondInstanceData) {
	wruntime.WindowUnminimise(a.ctx)
	wruntime.Show(a.ctx)
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

// ── Window close (mirrors the Electron confirm-close flow + v1.5.6 watchdog) ──
// Electron intercepted the window 'close', asked the renderer (onConfirmClose),
// and closed only after ForceClose() — with a 4s watchdog that force-closed a
// wedged renderer and killed in-flight FFmpeg (the Windows freeze-on-close fix).
// Wails' OnBeforeClose is the equivalent hook.

// onBeforeClose is wired via options.App.OnBeforeClose in main.go. Returning true
// prevents the close; we emit the confirm-close event and arm a watchdog. A live
// renderer acks immediately (ConfirmCloseAck → clears it); if none lands within
// the grace period we assume it's wedged, kill exports, and quit.
func (a *App) onBeforeClose(ctx context.Context) bool {
	if a.forceClose {
		return false // allow close
	}
	wruntime.EventsEmit(ctx, "app:confirm-close")

	a.watchdogMu.Lock()
	if a.closeWatchdog != nil {
		a.closeWatchdog.Stop()
	}
	a.closeWatchdog = time.AfterFunc(4*time.Second, func() {
		a.forceClose = true
		killAllExports()
		wruntime.Quit(ctx)
	})
	a.watchdogMu.Unlock()

	return true // prevent close; renderer shows the exit dialog
}

func (a *App) clearCloseWatchdog() {
	a.watchdogMu.Lock()
	if a.closeWatchdog != nil {
		a.closeWatchdog.Stop()
		a.closeWatchdog = nil
	}
	a.watchdogMu.Unlock()
}

// ForceClose is called by the renderer once the user confirms exit.
func (a *App) ForceClose() {
	a.clearCloseWatchdog()
	a.forceClose = true
	killAllExports() // don't leave an export running after the user exits
	wruntime.Quit(a.ctx)
}

// ConfirmCloseAck is the renderer's "I'm alive and showing the dialog" ack — it
// stands the wedged-renderer watchdog down.
func (a *App) ConfirmCloseAck() {
	a.clearCloseWatchdog()
}
