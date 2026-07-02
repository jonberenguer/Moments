package main

import (
	"os"
	"os/exec"
	"regexp"
	"strings"
)

// FFmpegStatus mirrors the Electron ffmpeg:check return shape.
type FFmpegStatus struct {
	Available bool   `json:"available"`
	Path      string `json:"path"`
}

// GPUCaps mirrors detectGPUCapabilities(). Lowercase json tags so the frontend's
// caps.nvenc / caps.vp9 / … reads work unchanged.
type GPUCaps struct {
	Nvenc   bool `json:"nvenc"`
	Amf     bool `json:"amf"`
	Qsv     bool `json:"qsv"`
	V4l2m2m bool `json:"v4l2m2m"`
	Cpu     bool `json:"cpu"`
	Vp9     bool `json:"vp9"`
	Opus    bool `json:"opus"`
	Vorbis  bool `json:"vorbis"`
	Gif     bool `json:"gif"`
}

func ffmpegAvailable(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && !fi.IsDir()
}

// FFmpegCheck reports whether the bundled FFmpeg binary is present.
func (a *App) FFmpegCheck() FFmpegStatus {
	p := ffmpegPath()
	return FFmpegStatus{Available: ffmpegAvailable(p), Path: p}
}

var gifEncoderRe = regexp.MustCompile(`(?m)(^|\s)gif(\s)`)

// DetectGPU parses `ffmpeg -encoders` for compiled-in HW encoders + alt-format
// codecs, and caches the result for the session.
//
// NOTE (M4): this is the encoder-availability parse only. The Electron version
// also smoke-tests each HW encoder with a 1-frame encode to reject encoders that
// are compiled-in but non-functional (e.g. NVENC on a box with no NVIDIA GPU).
// Those smoke tests will be ported alongside the export pipeline in M4.
func (a *App) DetectGPU() GPUCaps {
	if a.gpuCache != nil {
		return *a.gpuCache
	}
	caps := GPUCaps{Cpu: true}

	out, err := exec.Command(ffmpegPath(), "-hide_banner", "-encoders").CombinedOutput()
	if err == nil {
		raw := string(out)
		caps.Nvenc = strings.Contains(raw, "h264_nvenc")
		caps.Amf = strings.Contains(raw, "h264_amf")
		caps.Qsv = strings.Contains(raw, "h264_qsv")
		caps.V4l2m2m = strings.Contains(raw, "h264_v4l2m2m")
		caps.Vp9 = strings.Contains(raw, "libvpx-vp9")
		caps.Opus = strings.Contains(raw, "libopus")
		caps.Vorbis = strings.Contains(raw, "libvorbis")
		caps.Gif = gifEncoderRe.MatchString(raw)
	}

	a.gpuCache = &caps
	return caps
}

// ResetGPU clears the cached capabilities.
func (a *App) ResetGPU() bool {
	a.gpuCache = nil
	return true
}

// ── Export (M4) ───────────────────────────────────────────────────────────────
// The full export pipeline — resolve encoder tokens, spawn FFmpeg, stream
// ffmpeg:log / ffmpeg:stepStart / ffmpeg:stepDone / ffmpeg:encoderInfo events,
// temp-dir lifecycle — is M4. These stubs keep the bound surface complete so the
// frontend loads; StartExport fails gracefully until M4.

// StartExport is not yet implemented on the Wails backend (M4). It resolves with
// the Electron-style {ok:false, error} shape (not a rejection) so the frontend
// surfaces it gracefully.
func (a *App) StartExport(payload map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"ok":    false,
		"error": "export not yet implemented on Wails backend (M4)",
	}
}

// CancelExport is a no-op until the export pipeline lands (M4).
func (a *App) CancelExport(jobID string) {}
