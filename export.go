package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Export pipeline — the Go side of the Electron ffmpeg:export handler.
//
// DESIGN (see WAILS_MIGRATION_PLAN.md): the frontend (useFFmpeg.js) still builds
// all FFmpeg argument arrays and does the single-final-pass token swap; Go only
// resolves the three tokens (__ENCODER__ / __ENC_ARGS__ / __ENC_ARGS_HQ__),
// spawns FFmpeg per step, streams logs + progress as events, and returns the
// Electron-shaped result. Temp-dir cleanup stays renderer-owned (it reads the
// output after StartExport resolves, then calls Rmdir) — so we never delete it.

// ── Payload types (Wails unmarshals the JS object into these) ─────────────────

type ExportFallback struct {
	Label   string   `json:"label"`
	Args    []string `json:"args"`
	Message string   `json:"message"`
}

type ExportStep struct {
	Label          string          `json:"label"`
	Args           []string        `json:"args"`
	FallbackOnFail *ExportFallback `json:"fallbackOnFail"`
}

type ExportPayload struct {
	JobID           string       `json:"jobId"`
	Steps           []ExportStep `json:"steps"`
	EncoderOverride string       `json:"encoderOverride"`
	ExportQuality   string       `json:"exportQuality"`
	ExportBitrate   float64      `json:"exportBitrate"`
	TempDir         string       `json:"tempDir"`
}

// ── Active-job registry (for cancellation / kill-on-quit) ─────────────────────

type exportJob struct {
	cancelled atomic.Bool
	mu        sync.Mutex
	cur       *exec.Cmd // the currently-running FFmpeg step, if any
}

func (j *exportJob) kill() {
	j.cancelled.Store(true)
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.cur != nil && j.cur.Process != nil {
		_ = j.cur.Process.Kill()
	}
}

var (
	activeExportsMu sync.Mutex
	activeExports   = map[string]*exportJob{}
)

var errCancelled = errors.New("Cancelled")

// killAllExports cancels every in-flight export (used on window close / quit so
// no FFmpeg child outlives the app — the Windows close-freeze fix). Wired in M5.
func killAllExports() {
	activeExportsMu.Lock()
	jobs := make([]*exportJob, 0, len(activeExports))
	for _, j := range activeExports {
		jobs = append(jobs, j)
	}
	activeExportsMu.Unlock()
	for _, j := range jobs {
		j.kill()
	}
}

// scanLinesAny splits on either \r or \n so FFmpeg's carriage-return progress
// updates (frame=… time=…) stream individually — the renderer parses time= from
// each ffmpeg:log line to drive the progress bar.
func scanLinesAny(data []byte, atEOF bool) (int, []byte, error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	if i := bytes.IndexAny(data, "\r\n"); i >= 0 {
		return i + 1, data[:i], nil
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}

// StartExport runs the step list to completion, emitting progress events, and
// returns {ok:true,encoder,hw,steps} or {ok:false,error,cancelled}.
func (a *App) StartExport(payload ExportPayload) map[string]interface{} {
	jobID := payload.JobID
	tempDir := payload.TempDir
	if tempDir == "" {
		tempDir = filepath.Join(os.TempDir(), "moments_export_"+jobID)
	}
	_ = os.MkdirAll(tempDir, 0o755)

	ff := ffmpegPath()
	ensureExecutable(ff)
	if !ffmpegAvailable(ff) {
		return map[string]interface{}{
			"ok":    false,
			"error": fmt.Sprintf("FFmpeg binary not found at %q. Run \"node scripts/download-ffmpeg.js\" to install it.", ff),
		}
	}

	caps := a.DetectGPU()
	enc := resolveEncoder(caps, payload.EncoderOverride)
	encArgs := encoderQualityArgs(enc.Encoder, payload.ExportQuality, payload.ExportBitrate)
	encArgsHq := encoderIntermediateArgs(enc.Encoder)

	// NVENC on Windows/RDP may require -hwaccel cuda before the first input.
	var hwaccelInput []string
	if enc.Encoder == "h264_nvenc" && caps.NvencNeedsCuda {
		hwaccelInput = []string{"-hwaccel", "cuda"}
	}

	wruntime.EventsEmit(a.ctx, "ffmpeg:encoderInfo", map[string]interface{}{
		"jobId": jobID, "encoder": enc.Label, "hw": enc.Hw,
	})

	job := &exportJob{}
	activeExportsMu.Lock()
	activeExports[jobID] = job
	activeExportsMu.Unlock()
	defer func() {
		activeExportsMu.Lock()
		delete(activeExports, jobID)
		activeExportsMu.Unlock()
	}()

	// resolveArgs: expand the three tokens and insert hwaccel args before the
	// first -i (matches main.js resolveArgs exactly).
	resolveArgs := func(args []string) []string {
		out := make([]string, 0, len(args)+len(encArgs)+len(encArgsHq)+len(hwaccelInput))
		hwInserted := false
		for _, tok := range args {
			if !hwInserted && len(hwaccelInput) > 0 && tok == "-i" {
				out = append(out, hwaccelInput...)
				hwInserted = true
			}
			switch tok {
			case "__ENCODER__":
				out = append(out, enc.Encoder)
			case "__ENC_ARGS__":
				out = append(out, encArgs...)
			case "__ENC_ARGS_HQ__":
				out = append(out, encArgsHq...)
			default:
				out = append(out, tok)
			}
		}
		return out
	}

	runStep := func(label string, args []string) error {
		if job.cancelled.Load() {
			return errCancelled
		}
		full := append([]string{"-hide_banner", "-loglevel", "info"}, args...)
		cmd := exec.Command(ff, full...)
		stderr, err := cmd.StderrPipe()
		if err != nil {
			return fmt.Errorf("FFmpeg failed to start [%s]: %v", label, err)
		}
		if err := cmd.Start(); err != nil {
			return fmt.Errorf("FFmpeg failed to start [%s]: %v", label, err)
		}
		job.mu.Lock()
		job.cur = cmd
		job.mu.Unlock()

		tail := make([]string, 0, 12)
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		sc.Split(scanLinesAny)
		for sc.Scan() {
			line := sc.Text()
			if len(bytes.TrimSpace([]byte(line))) == 0 {
				continue
			}
			tail = append(tail, line)
			if len(tail) > 12 {
				tail = tail[1:]
			}
			wruntime.EventsEmit(a.ctx, "ffmpeg:log", map[string]interface{}{
				"jobId": jobID, "line": line, "label": label,
			})
		}
		werr := cmd.Wait()
		job.mu.Lock()
		job.cur = nil
		job.mu.Unlock()

		if job.cancelled.Load() {
			return errCancelled
		}
		if werr != nil {
			return fmt.Errorf("FFmpeg step [%s] failed: %v\n%s", label, werr, joinTail(tail))
		}
		return nil
	}

	doneLabels := []string{}
	for _, step := range payload.Steps {
		if job.cancelled.Load() {
			return map[string]interface{}{"ok": false, "error": "Cancelled", "cancelled": true}
		}
		wruntime.EventsEmit(a.ctx, "ffmpeg:stepStart", map[string]interface{}{"jobId": jobID, "label": step.Label})

		err := runStep(step.Label, resolveArgs(step.Args))
		if err != nil && err != errCancelled && step.FallbackOnFail != nil {
			fb := step.FallbackOnFail
			msg := fb.Message
			if msg == "" {
				msg = "  ↳ no audio stream — substituting silence"
			}
			wruntime.EventsEmit(a.ctx, "ffmpeg:log", map[string]interface{}{"jobId": jobID, "line": msg, "label": step.Label})
			err = runStep(fb.Label, resolveArgs(fb.Args))
		}
		if err != nil {
			return map[string]interface{}{"ok": false, "error": err.Error(), "cancelled": job.cancelled.Load()}
		}

		wruntime.EventsEmit(a.ctx, "ffmpeg:stepDone", map[string]interface{}{"jobId": jobID, "label": step.Label})
		doneLabels = append(doneLabels, step.Label)
	}

	return map[string]interface{}{"ok": true, "encoder": enc.Label, "hw": enc.Hw, "steps": doneLabels}
}

// CancelExport signals a running export to kill its current FFmpeg process.
func (a *App) CancelExport(jobID string) {
	activeExportsMu.Lock()
	job := activeExports[jobID]
	activeExportsMu.Unlock()
	if job != nil {
		job.kill()
	}
}

func joinTail(lines []string) string {
	out := ""
	for i, l := range lines {
		if i > 0 {
			out += "\n"
		}
		out += l
	}
	return out
}
