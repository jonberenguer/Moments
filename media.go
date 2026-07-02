package main

import (
	"encoding/base64"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Explicit content types so rendering never depends on the OS mime table
// (Go's builtin table lacks .mp4/.mov/etc, and a minimal system may have no
// /etc/mime.types).
var mediaContentType = map[string]string{
	".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
	".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".m4v": "video/x-m4v",
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
	".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic", ".avif": "image/avif",
}

// mediaHandler is the Wails AssetServer fallback handler that serves imported
// media off disk — the replacement for the Electron `media://` custom protocol.
//
// The frontend renders imported clips with
//   src="/media/<base64url(abs)>"   (see mediaUrlFor in useMediaStore.js)
// A base64url PATH SEGMENT (not a query param, not a raw path) is used on purpose:
// it survives both webview scheme handlers (WebView2 + WebKitGTK) and net/http
// path cleaning without slash/percent ambiguity. Requests the embedded
// frontend/dist doesn't satisfy fall through to this handler (Wails calls it on
// os.IsNotExist).
//
// http.ServeContent implements HTTP Range, so <video> seeking works.
func mediaHandler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/media/", func(w http.ResponseWriter, r *http.Request) {
		log.Printf("[media] request: %s", r.URL.Path)
		enc := strings.TrimPrefix(r.URL.Path, "/media/")
		raw, err := base64.RawURLEncoding.DecodeString(enc)
		if err != nil {
			log.Printf("[media] bad encoding %q: %v", enc, err)
			http.Error(w, "bad media path", http.StatusBadRequest)
			return
		}
		abs := string(raw)
		fi, err := os.Stat(abs)
		if err != nil || fi.IsDir() {
			log.Printf("[media] not found: %q (%v)", abs, err)
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		f, err := os.Open(abs)
		if err != nil {
			log.Printf("[media] open failed: %q: %v", abs, err)
			http.Error(w, "cannot open", http.StatusInternalServerError)
			return
		}
		defer f.Close()
		if ct := mediaContentType[strings.ToLower(filepath.Ext(abs))]; ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		log.Printf("[media] serving: %s (%d bytes) range=%q ct=%q",
			abs, fi.Size(), r.Header.Get("Range"), w.Header().Get("Content-Type"))
		http.ServeContent(w, r, filepath.Base(abs), fi.ModTime(), f)
	})

	return mux
}
