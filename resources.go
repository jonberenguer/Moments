package main

import (
	"os"
	"path/filepath"
	goruntime "runtime"
)

// resourcesBase returns the directory that holds the app's bundled resources
// (the `bin/` FFmpeg binaries and the fonts). Resolution order:
//   1. $MOMENTS_RESOURCES (explicit override)
//   2. the directory containing the executable, if it looks like the project/
//      install root (has a `bin/` dir)
//   3. the current working directory (the `wails dev` case → project root)
//
// TODO(M6): finalize the packaged layout (Wails does not have Electron's
// extraResources; fonts + ffmpeg will be shipped alongside the binary).
func resourcesBase() string {
	if env := os.Getenv("MOMENTS_RESOURCES"); env != "" {
		return env
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		if fi, err := os.Stat(filepath.Join(dir, "bin")); err == nil && fi.IsDir() {
			return dir
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		return cwd
	}
	return "."
}

// ffmpegPath resolves the bundled FFmpeg binary for the current OS.
func ffmpegPath() string {
	base := resourcesBase()
	switch goruntime.GOOS {
	case "windows":
		return filepath.Join(base, "bin", "win", "ffmpeg.exe")
	default:
		return filepath.Join(base, "bin", "linux", "ffmpeg")
	}
}

// fontsDir resolves the bundled drawtext fonts directory.
// TODO(M6): packaged builds will ship fonts next to the binary, not under
// frontend/public.
func fontsDir() string {
	return filepath.Join(resourcesBase(), "frontend", "public", "ffmpeg", "fonts")
}
