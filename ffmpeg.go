package main

import (
	"os"
	"os/exec"
	goruntime "runtime"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// FFmpegStatus mirrors the ffmpeg:check return shape.
type FFmpegStatus struct {
	Available bool   `json:"available"`
	Path      string `json:"path"`
}

// GPUCaps mirrors detectGPUCapabilities(). Lowercase json tags so the frontend's
// caps.nvenc / caps.vp9 / … reads work unchanged.
type GPUCaps struct {
	Nvenc          bool `json:"nvenc"`
	Amf            bool `json:"amf"`
	Qsv            bool `json:"qsv"`
	V4l2m2m        bool `json:"v4l2m2m"`
	Cpu            bool `json:"cpu"`
	Vp9            bool `json:"vp9"`
	Opus           bool `json:"opus"`
	Vorbis         bool `json:"vorbis"`
	Gif            bool `json:"gif"`
	NvencNeedsCuda bool `json:"nvencNeedsCuda"` // set when NVENC only opens with -hwaccel cuda (RDP/headless)
}

func ffmpegAvailable(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && !fi.IsDir()
}

// ensureExecutable restores the +x bit on POSIX (source checkouts / resource
// copies can drop it → spawn EACCES). Best-effort.
func ensureExecutable(bin string) {
	if goruntime.GOOS != "windows" {
		if fi, err := os.Stat(bin); err == nil && !fi.IsDir() {
			_ = os.Chmod(bin, 0o755)
		}
	}
}

// FFmpegCheck reports whether the bundled FFmpeg binary is present.
func (a *App) FFmpegCheck() FFmpegStatus {
	p := ffmpegPath()
	ensureExecutable(p)
	return FFmpegStatus{Available: ffmpegAvailable(p), Path: p}
}

var gifEncoderRe = regexp.MustCompile(`(?m)(^|\s)gif(\s)`)

// smokeTest runs a 1-frame 256×256 encode to confirm a HW encoder actually works
// (compiled-in ≠ functional). 256×256 because Ampere/Ada NVENC rejects smaller
// frames. Returns true on a clean exit. Ported from main.js smokeTest().
func smokeTest(ff, encoder string, extraArgs ...string) bool {
	tmpOut := filepath.Join(os.TempDir(), "moments_gpucheck.mp4")
	args := []string{
		"-f", "lavfi", "-i", "color=black:size=256x256:rate=1",
		"-frames:v", "1", "-c:v", encoder,
	}
	args = append(args, extraArgs...)
	args = append(args, "-y", tmpOut)

	cmd := exec.Command(ff, args...)
	if err := cmd.Start(); err != nil {
		return false
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		_ = os.Remove(tmpOut)
		return err == nil
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		<-done
		_ = os.Remove(tmpOut)
		return false
	}
}

// DetectGPU parses `ffmpeg -encoders` for compiled-in HW encoders + alt-format
// codecs, then smoke-tests each HW encoder to reject non-functional ones. Cached
// per session. Ported from detectGPUCapabilities().
func (a *App) DetectGPU() GPUCaps {
	if a.gpuCache != nil {
		return *a.gpuCache
	}
	caps := GPUCaps{Cpu: true}
	ff := ffmpegPath()
	ensureExecutable(ff)

	out, err := exec.Command(ff, "-hide_banner", "-encoders").CombinedOutput()
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

	// Smoke-test HW encoders (compiled-in ≠ working). NVENC on Windows/RDP may
	// only initialise with an explicit CUDA hwaccel device — record that so the
	// export inserts -hwaccel cuda before the first input.
	if caps.Nvenc {
		withCuda := false
		if goruntime.GOOS == "windows" {
			withCuda = smokeTest(ff, "h264_nvenc", "-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-preset", "p1")
		}
		caps.Nvenc = withCuda || smokeTest(ff, "h264_nvenc", "-preset", "p1")
		caps.NvencNeedsCuda = withCuda
	}
	if caps.Amf {
		caps.Amf = smokeTest(ff, "h264_amf", "-quality", "speed")
	}
	if caps.Qsv {
		caps.Qsv = smokeTest(ff, "h264_qsv", "-preset", "veryfast")
	}
	if caps.V4l2m2m {
		caps.V4l2m2m = smokeTest(ff, "h264_v4l2m2m")
	}

	a.gpuCache = &caps
	return caps
}

// ResetGPU clears the cached capabilities.
func (a *App) ResetGPU() bool {
	a.gpuCache = nil
	return true
}
