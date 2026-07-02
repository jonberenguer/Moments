package main

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// Verifies the media handler end-to-end (mux routing + base64url decode +
// ServeContent full GET + Range) independent of Wails/the webview.
func TestMediaHandlerServesFileAndRange(t *testing.T) {
	f, err := os.CreateTemp("", "moments_media_*.bin")
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("hello media range test 0123456789")
	if _, err := f.Write(content); err != nil {
		t.Fatal(err)
	}
	f.Close()
	defer os.Remove(f.Name())

	enc := base64.RawURLEncoding.EncodeToString([]byte(f.Name()))
	h := mediaHandler()

	// Full GET
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/media/"+enc, nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("full GET status = %d, want 200", rr.Code)
	}
	if body, _ := io.ReadAll(rr.Body); string(body) != string(content) {
		t.Fatalf("full GET body = %q", body)
	}

	// Range GET
	req := httptest.NewRequest("GET", "/media/"+enc, nil)
	req.Header.Set("Range", "bytes=0-4")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusPartialContent {
		t.Fatalf("range GET status = %d, want 206", rr.Code)
	}
	if body, _ := io.ReadAll(rr.Body); string(body) != "hello" {
		t.Fatalf("range GET body = %q, want %q", body, "hello")
	}
}
