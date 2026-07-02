package main

import (
	"net/http"
	"os"
	"path/filepath"
)

// mediaHandler is the Wails AssetServer fallback handler that serves imported
// media off disk — the replacement for the Electron `media://` custom protocol.
//
// The frontend renders imported clips with src="/media?p=<encodeURIComponent(abs)>"
// (see mediaUrlFor in useMediaStore.js). Requests that the embedded frontend/dist
// doesn't satisfy fall through to this handler.
//
// http.ServeContent implements HTTP Range, so <video> seeking works — the key
// thing to verify on WebKitGTK (Spike A) and WebView2.
func mediaHandler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/media", func(w http.ResponseWriter, r *http.Request) {
		// net/http has already URL-decoded the query value, so this is the real
		// absolute path.
		abs := r.URL.Query().Get("p")
		if abs == "" || !filepath.IsAbs(abs) {
			http.Error(w, "bad media path", http.StatusBadRequest)
			return
		}
		fi, err := os.Stat(abs)
		if err != nil || fi.IsDir() {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		f, err := os.Open(abs)
		if err != nil {
			http.Error(w, "cannot open", http.StatusInternalServerError)
			return
		}
		defer f.Close()
		// ServeContent sets Content-Type from the extension and honors Range.
		http.ServeContent(w, r, filepath.Base(abs), fi.ModTime(), f)
	})

	return mux
}
