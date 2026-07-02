package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

// Embed the built Vite frontend. `wails build` runs frontend:build first, which
// populates frontend/dist; a bare `go build` embeds the .gitkeep placeholder.
//
//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// Loopback HTTP media server — required for <video> on Linux/WebKitGTK (see
	// media.go). Its base URL is handed to the frontend via App.MediaBase().
	app := NewApp(startMediaServer())

	err := wails.Run(&options.App{
		Title:  "Moments",
		Width:  1280,
		Height: 800,
		AssetServer: &assetserver.Options{
			Assets: assets,
			// Kept as an <img> fallback (wails:// scheme). Video must use the
			// loopback http server (GStreamer can't fetch the custom scheme).
			Handler: mediaHandler(),
		},
		MinWidth:         1100,
		MinHeight:        700,
		BackgroundColour: &options.RGBA{R: 18, G: 18, B: 18, A: 1},
		OnStartup:        app.startup,
		OnBeforeClose:    app.onBeforeClose,
		OnShutdown:       app.onShutdown,
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop: true, // deliver OS file-drop paths to OnFileDrop
		},
		// Single-instance: a second launch focuses the existing window instead of
		// spinning up a rival that fights over prefs.json / temp export dirs.
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               "com.moments.app",
			OnSecondInstanceLaunch: app.onSecondInstance,
		},
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
