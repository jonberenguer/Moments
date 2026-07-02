package main

import (
	"os"
	"path/filepath"
	goruntime "runtime"
)

// Resource resolution for the bundled FFmpeg binary + drawtext fonts, working in
// both `wails dev` (repo layout) and a packaged install.
//
// Packaged layout (placed next to the executable by the installer / CI — see
// build/windows/installer + .github/workflows/wails-build.yml):
//
//	<install>/Moments(.exe)
//	<install>/ffmpeg/ffmpeg(.exe)
//	<install>/ffmpeg/fonts/*.ttf|otf|ttc
//
// (Mirrors the resources/ffmpeg/{ffmpeg,fonts} layout.) The frontend
// still embeds the fonts for the preview @font-face; FFmpeg reads them from disk
// here. TODO: de-dupe (serve the preview fonts from disk too) to shrink the binary.

func exeDir() string {
	if e, err := os.Executable(); err == nil {
		return filepath.Dir(e)
	}
	return ""
}

// resourcesBase returns the repo/install root. $MOMENTS_RESOURCES overrides;
// otherwise the executable dir if it looks like an install (has ffmpeg/ or bin/),
// else the working dir (the `wails dev` case → repo root).
func resourcesBase() string {
	if env := os.Getenv("MOMENTS_RESOURCES"); env != "" {
		return env
	}
	if d := exeDir(); d != "" {
		for _, marker := range []string{"ffmpeg", "bin"} {
			if fi, err := os.Stat(filepath.Join(d, marker)); err == nil && fi.IsDir() {
				return d
			}
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		return cwd
	}
	return "."
}

// firstExisting returns the first path that exists, else the last candidate (so
// callers still get a sensible default path to report in errors).
func firstExisting(cands ...string) string {
	for _, c := range cands {
		if c == "" {
			continue
		}
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	if len(cands) > 0 {
		return cands[len(cands)-1]
	}
	return ""
}

// ffmpegPath resolves the bundled FFmpeg binary for the current OS.
func ffmpegPath() string {
	base := resourcesBase()
	d := exeDir()
	sub, bin := "linux", "ffmpeg"
	if goruntime.GOOS == "windows" {
		sub, bin = "win", "ffmpeg.exe"
	}
	return firstExisting(
		filepath.Join(d, "ffmpeg", bin),      // packaged: <exe>/ffmpeg/ffmpeg(.exe)
		filepath.Join(base, "bin", sub, bin), // dev: <root>/bin/<os>/ffmpeg
	)
}

// fontsDir resolves the bundled drawtext fonts directory.
func fontsDir() string {
	base := resourcesBase()
	d := exeDir()
	return firstExisting(
		filepath.Join(d, "ffmpeg", "fonts"),                          // packaged
		filepath.Join(base, "frontend", "public", "ffmpeg", "fonts"), // dev
	)
}
