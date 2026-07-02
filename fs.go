package main

import (
	"encoding/base64"
	"io"
	"os"
	"path/filepath"
)

// File-system helpers reproducing the fs:* IPC handlers. Base64 is kept
// for ReadFile/WriteFile to match the existing renderer contract (the browser
// File fallback path base64-writes); native path copies use CopyFile directly.

// ReadFile returns the file contents base64-encoded.
func (a *App) ReadFile(path string) (string, error) {
	buf, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(buf), nil
}

// WriteFile writes base64-decoded data to path.
func (a *App) WriteFile(path, b64 string) error {
	buf, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return err
	}
	return os.WriteFile(path, buf, 0o644)
}

// CopyFile copies src → dest (used by export to stage media from disk).
func (a *App) CopyFile(src, dest string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err = io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}

// DeleteFile removes a file (best-effort, matches the try/catch).
func (a *App) DeleteFile(path string) bool {
	_ = os.Remove(path)
	return true
}

// FileExists reports whether path exists.
func (a *App) FileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// Mkdtemp creates a unique temp directory under the OS temp dir.
func (a *App) Mkdtemp(prefix string) (string, error) {
	if prefix == "" {
		prefix = "moments_"
	}
	return os.MkdirTemp("", prefix)
}

// Rmdir recursively removes a directory (best-effort).
func (a *App) Rmdir(path string) bool {
	_ = os.RemoveAll(path)
	return true
}

// ResourcesPath returns the base dir holding bundled resources (bin/, fonts).
func (a *App) ResourcesPath() string {
	return resourcesBase()
}

// FontPath resolves a bundled drawtext font file to its absolute path.
func (a *App) FontPath(fontFile string) string {
	return filepath.Join(fontsDir(), fontFile)
}
